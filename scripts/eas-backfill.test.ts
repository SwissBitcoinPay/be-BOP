import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDb } from '../src/lib/server/test-utils';
import { collections, db } from '../src/lib/server/database';
import { withTransaction } from '../src/lib/server/database';
import { enqueueEasDeclarations } from '../src/lib/server/eas/queue';
import { EU_COUNTRIES as EU_IN_APP } from '../src/lib/server/eas/declaration';
import type { Order } from '../src/lib/types/Order';
// @ts-expect-error plain JavaScript script
import { easBackfill, EU_COUNTRIES } from './eas-backfill.mjs';

function order(number: number, country: string, status = 'paid') {
	return {
		_id: `order-${number}`,
		number,
		status,
		createdAt: new Date('2026-11-01T00:00:00Z'),
		shippingAddress: { firstName: 'A', lastName: 'B', address: 'x', city: 'y', zip: 'z', country },
		payments: [{ status: 'paid', paidAt: new Date('2026-11-01T10:00:00Z') }]
	} as unknown as Order;
}

describe('eas-backfill script', () => {
	beforeEach(async () => {
		await cleanDb();
		await collections.orders.insertMany([
			order(1, 'DE'),
			order(2, 'CH'),
			order(3, 'FR', 'pending'),
			order(4, 'IT'),
			order(5, 'GB'),
			order(6, 'NO')
		]);
	});

	afterAll(async () => {
		await cleanDb();
	});

	it('uses the same EU countries as the app', () => {
		expect([...EU_COUNTRIES].sort()).toEqual([...EU_IN_APP].sort());
	});

	it('lists paid EU orders without writing anything by default', async () => {
		const result = await easBackfill(db, { environment: 'production', write: false });
		expect(result.toQueue.map((o: { number: number }) => o.number)).toEqual([1, 4]);
		expect(result.toQueue[0]).toEqual({
			number: 1,
			country: 'DE',
			paidAt: new Date('2026-11-01T10:00:00Z')
		});
		expect(await collections.easDeclarations.countDocuments()).toBe(0);
	});

	it('queues them with --write, once, and leaves already queued orders alone', async () => {
		// Order 1 was queued when it was paid
		await withTransaction((session) => enqueueEasDeclarations(order(1, 'DE'), session));
		await collections.easDeclarations.updateMany(
			{ externalOrderId: '1' },
			{ $set: { status: 'successful' } }
		);

		const first = await easBackfill(db, { environment: 'production', write: true });
		expect(first.toQueue.map((o: { number: number }) => o.number)).toEqual([4]);
		expect(first.alreadyQueued).toBe(1);

		const second = await easBackfill(db, { environment: 'production', write: true });
		expect(second.toQueue).toEqual([]);
		expect(second.alreadyQueued).toBe(2);

		expect(
			await collections.easDeclarations
				.find(
					{ environment: 'production' },
					{ projection: { _id: 0, externalOrderId: 1, status: 1, source: 1, orderId: 1 } }
				)
				.sort({ externalOrderId: 1 })
				.toArray()
		).toEqual([
			{ externalOrderId: '1', orderId: 'order-1', status: 'successful', source: 'paid' },
			{ externalOrderId: '4', orderId: 'order-4', status: 'pending', source: 'backfill' }
		]);
		// Only the environment asked for
		expect(await collections.easDeclarations.countDocuments({ environment: 'test' })).toBe(1);
	});

	it('can be limited to orders created since a date', async () => {
		await collections.orders.updateOne(
			{ number: 4 },
			{ $set: { createdAt: new Date('2026-12-01') } }
		);
		const result = await easBackfill(db, {
			environment: 'production',
			write: false,
			since: new Date('2026-11-15')
		});
		expect(result.toQueue.map((o: { number: number }) => o.number)).toEqual([4]);
	});
});
