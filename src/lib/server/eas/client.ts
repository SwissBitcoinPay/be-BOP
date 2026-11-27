import type { EasEnvironment } from '$lib/types/EasDeclaration';
import type { EasOrderEntry } from './declaration';

/** From EAS's API documentation (https://api-doc.easproject.com/) */
export const EAS_BASE_URLS: Record<EasEnvironment, string> = {
	test: 'https://internal1.easproject.com/api/',
	production: 'https://manager.easproject.com/api/'
};

/**
 * EAS answered with an HTTP error. `body` is EAS's error (it may echo order fields: never log it).
 */
export class EasHttpError extends Error {
	constructor(
		readonly status: number,
		readonly body: unknown,
		what: string
	) {
		super(`EAS ${what}: HTTP ${status}`);
	}
}

/**
 * No answer from EAS. `maybeReceived` is false only when the connection was never established,
 * so the request certainly did not reach EAS; otherwise EAS may have processed it.
 */
export class EasNetworkError extends Error {
	constructor(
		readonly maybeReceived: boolean,
		what: string,
		code: string
	) {
		super(`EAS ${what}: no response (${code})`);
	}
}

/** Errors raised before a single byte reached the server */
const NOT_CONNECTED_CODES = new Set([
	'ECONNREFUSED',
	'ENOTFOUND',
	'EAI_AGAIN',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'UND_ERR_CONNECT_TIMEOUT'
]);

export type EasOrderResult =
	| { external_order_id: string; status: 'successful'; checkout_token?: string }
	| { external_order_id: string; status: 'rejected'; error?: unknown; data?: unknown }
	| { external_order_id: string; status: string; [key: string]: unknown };

export interface EasClient {
	/** Gets (or reuses) an access token. Changes nothing at EAS: safe to retry. */
	authenticate(): Promise<void>;
	/** Sends one order as a bulk upload file, returns EAS's job id */
	submitOrder(entry: EasOrderEntry): Promise<string>;
	/** `completed` once every order of the job has a result */
	getJobStatus(jobId: string): Promise<string>;
	/** null while the job is still pending */
	getOrderResults(jobId: string): Promise<EasOrderResult[] | null>;
}

export function createEasClient(opts: {
	baseUrl: string;
	clientId: string;
	clientSecret: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
	now?: () => number;
}): EasClient {
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const now = opts.now ?? Date.now;
	let token: { value: string; expiresAt: number } | null = null;

	async function call(what: string, url: string, init: RequestInit): Promise<unknown> {
		let res: Response;
		try {
			res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		} catch (err) {
			const code =
				(err as { cause?: { code?: string } })?.cause?.code ??
				(err as { name?: string })?.name ??
				'unknown';
			throw new EasNetworkError(!NOT_CONNECTED_CODES.has(code), what, code);
		}
		const text = await res.text().catch(() => '');
		let body: unknown = text;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			// not JSON: keep the text
		}
		if (!res.ok) {
			if (res.status === 401) {
				token = null;
			}
			throw new EasHttpError(res.status, body, what);
		}
		return body;
	}

	async function bearer(): Promise<string> {
		if (token && token.expiresAt > now()) {
			return token.value;
		}
		const body = (await call('token', new URL('auth/open-id/connect', opts.baseUrl).href, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'client_credentials',
				scope: 'openid',
				client_id: opts.clientId,
				client_secret: opts.clientSecret
			})
		})) as { access_token?: string; expires_in?: number } | null;
		if (!body?.access_token) {
			throw new EasHttpError(200, null, 'token: no access_token in response');
		}
		// Renew a minute before it expires
		token = {
			value: body.access_token,
			expiresAt: now() + Math.max((body.expires_in ?? 300) - 60, 30) * 1000
		};
		return token.value;
	}

	return {
		async authenticate() {
			await bearer();
		},

		async submitOrder(entry) {
			const auth = await bearer();
			const form = new FormData();
			form.append(
				'file',
				new Blob([JSON.stringify({ order_list: [entry] })], { type: 'application/json' }),
				`order-${entry.order.external_order_id}.json`
			);
			const body = (await call(
				'bulk upload',
				new URL('mass-sale/create_post_sale_without_lc_orders', opts.baseUrl).href,
				{ method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: form }
			)) as { job_id?: string | number } | null;
			if (body?.job_id === undefined || body.job_id === null || body.job_id === '') {
				// EAS answered 2xx without a job: it may still have created one
				throw new EasNetworkError(true, 'bulk upload', 'no job_id in response');
			}
			return String(body.job_id);
		},

		async getJobStatus(jobId) {
			const auth = await bearer();
			const body = (await call(
				'job status',
				new URL(
					`mass-sale/get_post_sale_without_lc_job_status/${encodeURIComponent(jobId)}`,
					opts.baseUrl
				).href,
				{ headers: { Authorization: `Bearer ${auth}` } }
			)) as { status?: string } | null;
			return String(body?.status ?? '').toLowerCase();
		},

		async getOrderResults(jobId) {
			const auth = await bearer();
			const body = (await call(
				'order status',
				new URL(
					`mass-sale/get_post_sale_without_lc_order_status/${encodeURIComponent(jobId)}`,
					opts.baseUrl
				).href,
				{ headers: { Authorization: `Bearer ${auth}` } }
			)) as { order_response_list?: EasOrderResult[] } | null;
			return Array.isArray(body?.order_response_list) ? body.order_response_list : null;
		}
	};
}
