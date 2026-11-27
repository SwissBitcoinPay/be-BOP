import { describe, expect, it, vi } from 'vitest';
import { createEasClient, EAS_BASE_URLS, EasHttpError, EasNetworkError } from './client';
import type { EasOrderEntry } from './declaration';

const SECRET = 'very-secret-client-secret';

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function setup(responses: Array<Response | Error>) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const next = responses.shift();
		if (!next) {
			throw new Error('unexpected request');
		}
		if (next instanceof Error) {
			throw next;
		}
		return next;
	});
	let clock = 1_000_000;
	const client = createEasClient({
		baseUrl: EAS_BASE_URLS.test,
		clientId: 'client-id',
		clientSecret: SECRET,
		fetch: fetchMock as unknown as typeof fetch,
		now: () => clock
	});
	return { client, calls, tick: (ms: number) => (clock += ms) };
}

const TOKEN = () => json({ access_token: 'access-1', expires_in: 3600, token_type: 'Bearer' });
const entry = {
	order: { external_order_id: '1042' },
	s10_code: '1042',
	sale_date: 'x'
} as unknown as EasOrderEntry;

function networkError(code: string) {
	return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

describe('EAS client', () => {
	it('targets the sandbox for test', () => {
		expect(EAS_BASE_URLS.test).toBe('https://internal1.easproject.com/api/');
	});

	it('gets a client-credentials token, then uploads the order as a one-order JSON file', async () => {
		const { client, calls } = setup([
			TOKEN(),
			json({ job_id: 988964, message: 'Job created successfully' })
		]);

		expect(await client.submitOrder(entry)).toBe('988964');

		expect(calls[0].url).toBe('https://internal1.easproject.com/api/auth/open-id/connect');
		expect(calls[0].init.method).toBe('POST');
		const form = new URLSearchParams(String(calls[0].init.body));
		expect(Object.fromEntries(form)).toEqual({
			grant_type: 'client_credentials',
			scope: 'openid',
			client_id: 'client-id',
			client_secret: SECRET
		});

		expect(calls[1].url).toBe(
			'https://internal1.easproject.com/api/mass-sale/create_post_sale_without_lc_orders'
		);
		expect(calls[1].init.headers).toEqual({ Authorization: 'Bearer access-1' });
		const file = (calls[1].init.body as FormData).get('file') as File;
		expect(file.name).toBe('order-1042.json');
		expect(file.type).toBe('application/json');
		expect(JSON.parse(await file.text())).toEqual({ order_list: [entry] });
	});

	it('reuses the token until a minute before it expires', async () => {
		const { client, calls, tick } = setup([
			TOKEN(),
			json({ job_id: 1, status: 'pending' }),
			json({ status: 'completed' }),
			json({ access_token: 'access-2', expires_in: 3600 }),
			json({ status: 'Completed' })
		]);
		await client.authenticate();
		expect(await client.getJobStatus('1')).toBe('pending');
		tick(3_000_000);
		expect(await client.getJobStatus('1')).toBe('completed');
		tick(600_000);
		expect(await client.getJobStatus('1')).toBe('completed');
		expect(calls.map((c) => c.url.replace(EAS_BASE_URLS.test, ''))).toEqual([
			'auth/open-id/connect',
			'mass-sale/get_post_sale_without_lc_job_status/1',
			'mass-sale/get_post_sale_without_lc_job_status/1',
			'auth/open-id/connect',
			'mass-sale/get_post_sale_without_lc_job_status/1'
		]);
		expect(calls[4].init.headers).toEqual({ Authorization: 'Bearer access-2' });
	});

	it('reads the per-order results, or null while the job is pending', async () => {
		const list = [{ external_order_id: '1042', status: 'successful', checkout_token: 'jwt' }];
		const { client } = setup([
			TOKEN(),
			json({
				job_id: '7',
				message: 'Cannot return order response list, Mass post sale job: 7 is still pending.'
			}),
			json({ job_id: '7', order_response_list: list })
		]);
		expect(await client.getOrderResults('7')).toBeNull();
		expect(await client.getOrderResults('7')).toEqual(list);
	});

	it('drops the token after a 401, and never puts the secret in an error', async () => {
		const { client, calls } = setup([
			json({ message: 'Invalid client credentials', code: 401, retryable: false }, 401),
			TOKEN(),
			json({ message: 'expired' }, 401),
			TOKEN(),
			json({ status: 'completed' })
		]);
		const err = await client.authenticate().catch((e) => e);
		expect(err).toBeInstanceOf(EasHttpError);
		expect(err.status).toBe(401);
		expect(String(err.message) + JSON.stringify(err)).not.toContain(SECRET);

		await expect(client.getJobStatus('1')).rejects.toMatchObject({ status: 401 });
		expect(await client.getJobStatus('1')).toBe('completed');
		expect(calls.filter((c) => c.url.endsWith('auth/open-id/connect'))).toHaveLength(3);
	});

	it('tells a request that never reached EAS from one that may have', async () => {
		const { client } = setup([
			TOKEN(),
			networkError('ECONNREFUSED'),
			networkError('ECONNRESET'),
			Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
			json({ message: 'ok but no job' })
		]);
		await client.authenticate();
		await expect(client.submitOrder(entry)).rejects.toMatchObject({ maybeReceived: false });
		await expect(client.submitOrder(entry)).rejects.toMatchObject({ maybeReceived: true });
		await expect(client.submitOrder(entry)).rejects.toMatchObject({ maybeReceived: true });
		const err = await client.submitOrder(entry).catch((e) => e);
		expect(err).toBeInstanceOf(EasNetworkError);
		expect(err.maybeReceived).toBe(true);
	});

	it('keeps EAS error bodies out of the error message', async () => {
		const body = { message: 'Invalid email ada@example.com', code: 400, type: 'STOP_SELLING' };
		const { client } = setup([TOKEN(), json(body, 400)]);
		const err = await client.submitOrder(entry).catch((e) => e);
		expect(err).toBeInstanceOf(EasHttpError);
		expect(err.message).toBe('EAS bulk upload: HTTP 400');
		expect(err.body).toEqual(body);
	});
});
