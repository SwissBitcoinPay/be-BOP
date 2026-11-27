import type { ClientSession } from 'mongodb';
import { ObjectId } from 'mongodb';
import { collections } from '$lib/server/database';
import { ORIGIN, SMTP_USER } from '$lib/server/env-config';
import { runtimeConfig } from '$lib/server/runtime-config';
import type { Order } from '$lib/types/Order';
import {
	EAS_ENVIRONMENTS,
	type EasDeclaration,
	type EasDeclarationStatus,
	type EasEnvironment
} from '$lib/types/EasDeclaration';
import { escapeHtml } from '$lib/utils/escapeHtml';
import { buildEasDeclaration, isEuCountry, type EasDeclarationContext } from './declaration';
import { EasHttpError, EasNetworkError, type EasClient } from './client';

/** Sends (and failed token requests) before giving up */
export const MAX_SEND_ATTEMPTS = 10;
/** Status polls of a submitted job before giving up (about two days with the delays below) */
export const MAX_POLL_ATTEMPTS = 16;
/** A send interrupted for this long (crash, restart) has an unknown outcome */
export const SUBMITTING_STALE_MS = 10 * 60_000;

const MINUTE = 60_000;

/** 1 min, 2 min, 4 min… capped at 6 h */
export function retryDelayMs(attempts: number): number {
	return Math.min(MINUTE * 2 ** Math.max(attempts - 1, 0), 6 * 60 * MINUTE);
}

/** First poll after 30 s, then 1 min, 2 min… capped at 6 h */
function pollDelayMs(attempts: number): number {
	return attempts <= 1 ? 30_000 : retryDelayMs(attempts - 1);
}

function log(decl: Pick<EasDeclaration, 'externalOrderId' | 'environment'>, message: string) {
	console.log(`[eas] order #${decl.externalOrderId} (${decl.environment}): ${message}`);
}

/**
 * Queues the declaration of a paid order, in the transaction that marks it paid, for every EAS
 * environment (test and production), whether or not sending is enabled. Only orders delivered
 * to the EU are queued; the worker decides which of them are IOSS sales.
 */
export async function enqueueEasDeclarations(
	order: Pick<Order, '_id' | 'number' | 'shippingAddress'>,
	session: ClientSession,
	source: EasDeclaration['source'] = 'paid'
): Promise<void> {
	if (!isEuCountry(order.shippingAddress?.country)) {
		console.log(`[eas] order #${order.number}: not queued, no delivery to the EU`);
		return;
	}
	const now = new Date();
	for (const environment of EAS_ENVIRONMENTS) {
		await collections.easDeclarations.updateOne(
			{ environment, externalOrderId: String(order.number) },
			{
				$setOnInsert: {
					_id: new ObjectId(),
					environment,
					externalOrderId: String(order.number),
					orderId: order._id,
					status: 'pending',
					source,
					attempts: 0,
					nextAttemptAt: now,
					createdAt: now,
					updatedAt: now
				}
			},
			{ upsert: true, session }
		);
	}
}

export interface EasWorkerDeps {
	environment: EasEnvironment;
	client: EasClient;
	context: () => EasDeclarationContext;
	now?: () => Date;
}

const ALERT_STATUSES: EasDeclarationStatus[] = ['needs_review', 'rejected', 'failed'];

/**
 * E-mails the shop owner, through be-BOP's own e-mail queue, about a declaration that needs a
 * person. The mail names the order and the reason, nothing about the customer.
 */
async function alertShopOwner(decl: EasDeclaration, status: EasDeclarationStatus, reason: string) {
	const dest = runtimeConfig.sellerIdentity?.contact.email || SMTP_USER;
	if (!dest) {
		log(decl, `${status}, and no shop e-mail address to alert`);
		return;
	}
	await collections.emailNotifications.insertOne({
		_id: new ObjectId(),
		createdAt: new Date(),
		updatedAt: new Date(),
		subject: `EAS ${decl.environment}: order #${decl.externalOrderId} ${status.replace('_', ' ')}`,
		htmlContent:
			`The EAS (${decl.environment}) IOSS declaration of ` +
			`<a href="${ORIGIN}/order/${encodeURIComponent(decl.orderId)}">order #${escapeHtml(
				decl.externalOrderId
			)}</a> is <b>${status.replace('_', ' ')}</b>.<br>` +
			`Reason: ${escapeHtml(reason)}<br><br>` +
			`It will not be sent again automatically. Details are in the easDeclarations collection.`,
		dest
	});
	await collections.easDeclarations.updateOne(
		{ _id: decl._id },
		{ $set: { alertedAt: new Date() } }
	);
}

async function finish(
	decl: EasDeclaration,
	status: EasDeclarationStatus,
	reason: string,
	extra: Partial<EasDeclaration> = {},
	fromStatus: EasDeclarationStatus = decl.status
): Promise<void> {
	const res = await collections.easDeclarations.updateOne(
		{ _id: decl._id, status: fromStatus },
		{ $set: { status, reason, completedAt: new Date(), updatedAt: new Date(), ...extra } }
	);
	if (!res.modifiedCount) {
		return;
	}
	log(decl, `${status} (${reason})`);
	if (ALERT_STATUSES.includes(status)) {
		await alertShopOwner(decl, status, reason).catch((err) =>
			log(decl, `could not queue the alert e-mail: ${(err as Error).message}`)
		);
	}
}

async function retryLater(
	decl: EasDeclaration,
	now: Date,
	reason: string,
	opts: {
		from: EasDeclarationStatus;
		to: EasDeclarationStatus;
		maxAttempts: number;
		delay: (attempts: number) => number;
	}
): Promise<void> {
	const attempts = decl.attempts + 1;
	if (attempts >= opts.maxAttempts) {
		await finish(
			decl,
			'failed',
			`gave up after ${attempts} attempts: ${reason}`,
			{ attempts },
			opts.from
		);
		return;
	}
	await collections.easDeclarations.updateOne(
		{ _id: decl._id, status: opts.from },
		{
			$set: {
				status: opts.to,
				attempts,
				reason,
				nextAttemptAt: new Date(now.getTime() + opts.delay(attempts)),
				updatedAt: now
			}
		}
	);
	log(decl, `will retry (attempt ${attempts}): ${reason}`);
}

const SEND_RETRY = { maxAttempts: MAX_SEND_ATTEMPTS, delay: retryDelayMs };
const POLL_RETRY = { maxAttempts: MAX_POLL_ATTEMPTS, delay: pollDelayMs };

/** EAS's error type and code, without its message (which may quote customer data) */
function describeHttpError(err: EasHttpError): string {
	const body = err.body as { type?: string; code?: number | string } | null;
	const type = body && typeof body === 'object' && body.type ? ` ${body.type}` : '';
	return `${err.message}${type}`;
}

async function send(decl: EasDeclaration, deps: EasWorkerDeps, now: Date): Promise<void> {
	const order = await collections.orders.findOne({ _id: decl.orderId });
	if (!order) {
		await finish(decl, 'needs_review', 'order not found');
		return;
	}

	const decision = buildEasDeclaration(order, deps.context());
	if (decision.kind !== 'declare') {
		await finish(decl, decision.kind, decision.reason);
		return;
	}

	// Get the token first: failing to get one changes nothing at EAS.
	try {
		await deps.client.authenticate();
	} catch (err) {
		await retryLater(decl, now, (err as Error).message, {
			from: 'pending',
			to: 'pending',
			...SEND_RETRY
		});
		return;
	}

	// Claim the send: from here on, an interruption leaves it `submitting`, never resent.
	const claimed = await collections.easDeclarations.findOneAndUpdate(
		{ _id: decl._id, status: 'pending' },
		{ $set: { status: 'submitting', request: decision.entry, updatedAt: now } },
		{ returnDocument: 'after' }
	);
	if (!claimed.value) {
		return;
	}
	const submitting = claimed.value;

	try {
		const jobId = await deps.client.submitOrder(decision.entry);
		await collections.easDeclarations.updateOne(
			{ _id: decl._id, status: 'submitting' },
			{
				$set: {
					status: 'submitted',
					jobId,
					submittedAt: now,
					attempts: 0,
					nextAttemptAt: new Date(now.getTime() + pollDelayMs(1)),
					updatedAt: now
				},
				$unset: { reason: 1 }
			}
		);
		log(decl, `submitted, EAS job ${jobId}`);
	} catch (err) {
		const certainlyNotReceived =
			(err instanceof EasNetworkError && !err.maybeReceived) ||
			// Refused before processing: unauthorized, throttled, or the gateway had no backend
			(err instanceof EasHttpError && [401, 408, 429, 502, 503].includes(err.status));
		if (certainlyNotReceived) {
			await retryLater(submitting, now, (err as Error).message, {
				from: 'submitting',
				to: 'pending',
				...SEND_RETRY
			});
		} else if (err instanceof EasHttpError && err.status >= 400 && err.status < 500) {
			// EAS validated the file and refused it: nothing was created
			await finish(
				submitting,
				'rejected',
				`refused by EAS before processing: ${describeHttpError(err)}`,
				{ easError: err.body }
			);
		} else {
			await finish(
				submitting,
				'needs_review',
				`outcome of the send is unknown (${
					(err as Error).message
				}): check the EAS dashboard before sending it again`,
				err instanceof EasHttpError ? { easError: err.body } : {}
			);
		}
	}
}

async function poll(decl: EasDeclaration, deps: EasWorkerDeps, now: Date): Promise<void> {
	if (!decl.jobId) {
		await finish(decl, 'needs_review', 'submitted without a job id');
		return;
	}
	try {
		const jobStatus = await deps.client.getJobStatus(decl.jobId);
		const results =
			jobStatus === 'completed' ? await deps.client.getOrderResults(decl.jobId) : null;
		if (!results) {
			await retryLater(decl, now, `EAS job ${decl.jobId} still ${jobStatus || 'pending'}`, {
				from: 'submitted',
				to: 'submitted',
				...POLL_RETRY
			});
			return;
		}
		const result = results.find((r) => String(r.external_order_id) === decl.externalOrderId);
		if (!result) {
			await finish(decl, 'needs_review', `EAS job ${decl.jobId} completed without this order`);
		} else if (result.status === 'successful') {
			await finish(decl, 'successful', `EAS job ${decl.jobId}`, {
				checkoutToken: typeof result.checkout_token === 'string' ? result.checkout_token : undefined
			});
		} else if (result.status === 'rejected') {
			const error = (result as { error?: { type?: string; code?: number } }).error;
			await finish(
				decl,
				'rejected',
				`rejected by EAS (job ${decl.jobId}${error?.type ? `, ${error.type}` : ''}${
					error?.code ? `, code ${error.code}` : ''
				})`,
				{ easError: error ?? result }
			);
		} else {
			await finish(decl, 'needs_review', `unknown EAS order status "${String(result.status)}"`, {
				easError: result
			});
		}
	} catch (err) {
		// Status reads change nothing at EAS: always safe to retry
		await retryLater(decl, now, (err as Error).message, {
			from: 'submitted',
			to: 'submitted',
			...POLL_RETRY
		});
	}
}

/**
 * Processes the declarations of one EAS environment that are due. Returns how many it handled.
 */
export async function processDueEasDeclarations(deps: EasWorkerDeps, limit = 20): Promise<number> {
	const now = deps.now?.() ?? new Date();

	// Sends interrupted mid-way: their outcome is unknown, never resend them blindly.
	const stale = await collections.easDeclarations
		.find({
			environment: deps.environment,
			status: 'submitting',
			updatedAt: { $lt: new Date(now.getTime() - SUBMITTING_STALE_MS) }
		})
		.toArray();
	for (const decl of stale) {
		await finish(
			decl,
			'needs_review',
			'send interrupted, outcome unknown: check the EAS dashboard before sending it again'
		);
	}

	const due = await collections.easDeclarations
		.find({
			environment: deps.environment,
			status: { $in: ['pending', 'submitted'] },
			nextAttemptAt: { $lte: now }
		})
		.sort({ nextAttemptAt: 1 })
		.limit(limit)
		.toArray();

	for (const decl of due) {
		try {
			if (decl.status === 'pending') {
				await send(decl, deps, now);
			} else {
				await poll(decl, deps, now);
			}
		} catch (err) {
			log(decl, `error: ${(err as Error).message}`);
		}
	}
	return stale.length + due.length;
}
