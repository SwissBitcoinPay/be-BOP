import type { ObjectId } from 'mongodb';
import type { Order } from './Order';
import type { Timestamps } from './Timestamps';

/** EAS has a test (sandbox) and a production environment: a sale is declared once in each. */
export const EAS_ENVIRONMENTS = ['test', 'production'] as const;
export type EasEnvironment = (typeof EAS_ENVIRONMENTS)[number];

/**
 * - pending: to send (again, after `nextAttemptAt`)
 * - submitting: being sent; if it stays so, the send's outcome is unknown and it is never resent
 * - submitted: accepted by EAS as a job, whose result is polled
 * - successful / rejected: EAS's verdict, final
 * - skipped: not to declare (B2B, outside the EU), final
 * - needs_review: a person must look at it before anything is sent, final until reset by hand
 * - failed: gave up after too many errors, final until reset by hand
 */
export const EAS_DECLARATION_STATUSES = [
	'pending',
	'submitting',
	'submitted',
	'successful',
	'rejected',
	'skipped',
	'needs_review',
	'failed'
] as const;
export type EasDeclarationStatus = (typeof EAS_DECLARATION_STATUSES)[number];

/**
 * One sale to declare to EAS (IOSS, post-sale without landed cost), in one EAS environment.
 *
 * Unique on (environment, externalOrderId): the same order is declared at most once per
 * environment. Orders are never modified; everything about the declaration lives here.
 */
export interface EasDeclaration extends Timestamps {
	_id: ObjectId;
	environment: EasEnvironment;
	/** be-BOP order number, as sent to EAS in `external_order_id` */
	externalOrderId: string;
	orderId: Order['_id'];
	status: EasDeclarationStatus;
	/** How it was queued: when the order was paid, or by the catch-up script */
	source: 'paid' | 'backfill';
	/** Number of sends and status polls made so far */
	attempts: number;
	nextAttemptAt: Date;
	/** Why it is skipped, needs review or failed, or the last error. Never customer data. */
	reason?: string;
	/** The body sent to EAS (customer data, like the order itself; never logged) */
	request?: unknown;
	jobId?: string;
	submittedAt?: Date;
	/** EAS's per-order result: the checkout token when successful, the error when rejected */
	checkoutToken?: string;
	easError?: unknown;
	completedAt?: Date;
	/** When the shop owner was e-mailed about a needs_review, rejected or failed status */
	alertedAt?: Date;
}
