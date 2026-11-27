import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { cleanDb } from '../test-utils';
import { collections, withTransaction } from '../database';
import { runtimeConfig } from '../runtime-config';
import { createOrder, onOrderPayment } from '../orders';
import { TEST_PHYSICAL_PRODUCT } from '../seed/product';
import type { Order, OrderAddress } from '$lib/types/Order';
import type { Product } from '$lib/types/Product';
import type { CountryAlpha2 } from '$lib/types/Country';
import type { EasDeclaration } from '$lib/types/EasDeclaration';
import { toCurrency } from '$lib/utils/toCurrency';
import { buildEasDeclaration, type EasDeclarationContext } from './declaration';
import { EasHttpError, EasNetworkError, type EasClient } from './client';
import {
	enqueueEasDeclarations,
	MAX_SEND_ATTEMPTS,
	processDueEasDeclarations,
	SUBMITTING_STALE_MS,
	type EasWorkerDeps
} from './queue';

const context = (): EasDeclarationContext => ({
	sellerCountry: 'CH',
	toEur: (amount, currency) => toCurrency('EUR', amount, currency)
});

function mockClient() {
	return {
		authenticate: vi.fn<EasClient['authenticate']>(async () => {}),
		submitOrder: vi.fn<EasClient['submitOrder']>(async () => '9001'),
		getJobStatus: vi.fn<EasClient['getJobStatus']>(async () => 'completed'),
		getOrderResults: vi.fn<EasClient['getOrderResults']>(async () => [])
	};
}

function address(country: CountryAlpha2, patch: Partial<OrderAddress> = {}): OrderAddress {
	return {
		firstName: 'Ada',
		lastName: 'Lovelace',
		address: '12 Hauptstraße',
		city: 'Somewhere',
		zip: '10115',
		country,
		...patch
	};
}

const CARD: Product = {
	...TEST_PHYSICAL_PRODUCT,
	_id: 'zap',
	alias: ['zap'],
	name: 'Zap',
	price: { amount: 5, currency: 'CHF', precision: 8 },
	stock: undefined
};
const OTHER_CARD: Product = { ...CARD, _id: 'seed', alias: ['seed'], name: 'Seed' };

/** Places and pays an order through be-BOP itself, as the storefront does */
async function placePaidOrder(
	country: CountryAlpha2,
	lines: Array<{ product: Product; quantity: number }>,
	patch: Partial<OrderAddress> = {}
): Promise<Order> {
	const orderId = await createOrder(lines, 'point-of-sale', {
		locale: 'en',
		user: { sessionId: 'test-session-id' },
		notifications: { paymentStatus: { email: 'ada@example.com' } },
		shippingAddress: address(country, patch),
		userVatCountry: country
	});
	const order = await collections.orders.findOne({ _id: orderId });
	if (!order) {
		throw new Error('order not created');
	}
	await onOrderPayment(order, order.payments[0], order.payments[0].price);
	const paid = await collections.orders.findOne({ _id: orderId });
	if (paid?.status !== 'paid') {
		throw new Error('order not paid');
	}
	return paid;
}

async function declarations(environment: 'test' | 'production' = 'test') {
	return collections.easDeclarations.find({ environment }).sort({ externalOrderId: 1 }).toArray();
}

async function queueTestOrder(order: Order) {
	await withTransaction((session) => enqueueEasDeclarations(order, session));
}

describe('EAS declarations', () => {
	const saved = {
		mainCurrency: runtimeConfig.mainCurrency,
		priceReferenceCurrency: runtimeConfig.priceReferenceCurrency,
		secondaryCurrency: runtimeConfig.secondaryCurrency,
		vatExempted: runtimeConfig.vatExempted,
		vatSingleCountry: runtimeConfig.vatSingleCountry,
		vatNullOutsideSellerCountry: runtimeConfig.vatNullOutsideSellerCountry,
		vatCountry: runtimeConfig.vatCountry,
		deliveryFees: runtimeConfig.deliveryFees,
		sellerIdentity: runtimeConfig.sellerIdentity
	};

	beforeEach(async () => {
		await cleanDb();
		await collections.products.insertMany([CARD, OTHER_CARD]);
		// The shop as it would charge EU VAT: CHF, destination-country VAT, 8 CHF flat delivery
		Object.assign(runtimeConfig, {
			mainCurrency: 'CHF',
			priceReferenceCurrency: 'CHF',
			secondaryCurrency: 'BTC',
			vatExempted: false,
			vatSingleCountry: false,
			vatNullOutsideSellerCountry: false,
			vatCountry: 'CH',
			deliveryFees: {
				...runtimeConfig.deliveryFees,
				mode: 'flatFee',
				applyFlatFeeToEachItem: false,
				onlyPayHighest: false,
				deliveryFees: { default: { amount: 8, currency: 'CHF' } },
				vatIncludedReference: false,
				vatProfileId: null
			},
			sellerIdentity: {
				...(runtimeConfig.sellerIdentity ?? {}),
				address: { street: 'x', zip: '1000', city: 'Lausanne', country: 'CH' },
				contact: { email: 'owner@shop.example', phone: '' }
			}
		});
	});

	afterEach(() => {
		Object.assign(runtimeConfig, saved);
	});

	describe('queueing, in the payment transaction', () => {
		it('queues a paid EU order once for test and once for production', async () => {
			const order = await placePaidOrder('DE', [{ product: CARD, quantity: 3 }]);

			for (const environment of ['test', 'production'] as const) {
				const [decl, ...others] = await declarations(environment);
				expect(others).toEqual([]);
				expect(decl).toMatchObject({
					externalOrderId: String(order.number),
					orderId: order._id,
					status: 'pending',
					source: 'paid',
					attempts: 0
				});
			}
			// The order itself is not modified by the queue
			expect(order).not.toHaveProperty('eas');
		});

		it('queues it even when sending is disabled (no worker involved)', async () => {
			await placePaidOrder('FR', [{ product: CARD, quantity: 1 }]);
			expect(await collections.easDeclarations.countDocuments()).toBe(2);
		});

		it.each(['CH', 'GB', 'NO', 'US'] as CountryAlpha2[])(
			'does not queue an order to %s',
			async (country) => {
				await placePaidOrder(country, [{ product: CARD, quantity: 1 }]);
				expect(await collections.easDeclarations.countDocuments()).toBe(0);
			}
		);

		it('never queues the same order twice for an environment', async () => {
			const order = await placePaidOrder('DE', [{ product: CARD, quantity: 1 }]);
			await queueTestOrder(order);
			await queueTestOrder(order);
			expect(await collections.easDeclarations.countDocuments()).toBe(2);
			await expect(
				collections.easDeclarations.insertOne({
					...(await declarations())[0],
					_id: new ObjectId()
				})
			).rejects.toThrow(/duplicate key/);
		});
	});

	describe('orders placed by be-BOP map exactly to what the customer paid', () => {
		it.each([
			['DE', 19, [3]],
			['FR', 20, [2, 1]],
			['HU', 27, [1]],
			// be-BOP's VAT table still has 24 % for Finland (25.5 % since 2024-09-01): declared as charged
			['FI', 24, [1, 1, 1]],
			['IT', 22, [4, 2]]
		] as Array<[CountryAlpha2, number, number[]]>)(
			'%s at %s %% with delivery, quantities %j',
			async (country, rate, quantities) => {
				const products = [CARD, OTHER_CARD, { ...CARD, _id: 'tick-tock', alias: ['tick-tock'] }];
				await collections.products.insertOne(products[2]);
				const order = await placePaidOrder(
					country,
					quantities.map((quantity, i) => ({ product: products[i], quantity }))
				);

				const decision = buildEasDeclaration(order, context());
				expect(decision.kind, 'reason' in decision ? decision.reason : '').toBe('declare');
				if (decision.kind !== 'declare') {
					return;
				}
				const { order: eas } = decision.entry;
				const cards = quantities.reduce((a, b) => a + b, 0);
				const vatCents = Math.round((cards * 5 + 8) * rate);

				expect(order.vat).toEqual([{ rate, country }]);
				expect(eas.payment_currency).toBe('CHF');
				expect(eas.total_order_amount).toBe(order.currencySnapshot.main.totalPrice.amount);
				expect(Math.round(eas.total_order_amount * 100)).toBe(cards * 500 + 800 + vatCents);
				expect(eas.order_breakdown.map((l) => l.vat_rate)).toEqual(quantities.map(() => rate));
				const itemVat = eas.order_breakdown.reduce(
					(s, l) => s + l.item_vat + l.item_delivery_charge_vat,
					0
				);
				expect(Math.round(itemVat * 100)).toBe(
					Math.round((order.currencySnapshot.main.vat?.[0].amount ?? NaN) * 100)
				);
				const sum = eas.order_breakdown.reduce(
					(s, l) =>
						s +
						l.unit_cost * l.quantity +
						l.item_vat +
						l.item_delivery_charge +
						l.item_delivery_charge_vat,
					0
				);
				expect(Math.round(sum * 100)).toBe(Math.round(eas.total_order_amount * 100));
			}
		);

		it('needs review for an order of the shop as configured today (VAT exempted)', async () => {
			runtimeConfig.vatExempted = true;
			const order = await placePaidOrder('DE', [{ product: CARD, quantity: 3 }]);
			const decision = buildEasDeclaration(order, context());
			expect(decision.kind).toBe('needs_review');
		});
	});

	describe('worker', () => {
		let order: Order;
		let client: ReturnType<typeof mockClient>;
		let now: Date;
		const deps = (): EasWorkerDeps => ({ environment: 'test', client, context, now: () => now });

		beforeEach(async () => {
			order = await placePaidOrder('DE', [{ product: CARD, quantity: 3 }]);
			client = mockClient();
			client.getOrderResults.mockResolvedValue([
				{
					external_order_id: String(order.number),
					status: 'successful',
					checkout_token: 'jwt.token.sig'
				}
			]);
			now = new Date();
		});

		const advance = (ms: number) => {
			now = new Date(now.getTime() + ms);
		};
		const decl = async () => (await declarations('test'))[0] as EasDeclaration;
		const alerts = () => collections.emailNotifications.find({ subject: /^EAS/ }).toArray();

		it('sends, polls the job and records the successful result', async () => {
			client.getJobStatus.mockResolvedValueOnce('pending');

			await processDueEasDeclarations(deps());
			expect(client.submitOrder).toHaveBeenCalledTimes(1);
			const sent = client.submitOrder.mock.calls[0][0];
			expect(sent.order.external_order_id).toBe(String(order.number));
			expect(await decl()).toMatchObject({ status: 'submitted', jobId: '9001', request: sent });

			// Not yet due
			await processDueEasDeclarations(deps());
			expect(client.getJobStatus).not.toHaveBeenCalled();

			advance(31_000);
			await processDueEasDeclarations(deps());
			expect(await decl()).toMatchObject({ status: 'submitted', attempts: 1 });

			advance(61_000);
			await processDueEasDeclarations(deps());
			expect(await decl()).toMatchObject({ status: 'successful', checkoutToken: 'jwt.token.sig' });
			expect(client.getOrderResults).toHaveBeenCalledWith('9001');

			// Nothing more, ever
			advance(24 * 3600_000);
			await processDueEasDeclarations(deps());
			expect(client.submitOrder).toHaveBeenCalledTimes(1);
			expect(await alerts()).toEqual([]);
		});

		it('only processes its own environment', async () => {
			await processDueEasDeclarations(deps());
			expect((await declarations('production'))[0].status).toBe('pending');
		});

		it('sends once when two workers run at the same time', async () => {
			let release: () => void = () => {};
			client.submitOrder.mockImplementation(
				() => new Promise((resolve) => (release = () => resolve('9001')))
			);
			const first = processDueEasDeclarations(deps());
			const second = processDueEasDeclarations(deps());
			await vi.waitFor(() => expect(client.submitOrder).toHaveBeenCalled());
			release();
			await Promise.all([first, second]);
			expect(client.submitOrder).toHaveBeenCalledTimes(1);
		});

		it('retries with a growing delay when EAS could not be reached, then gives up and alerts', async () => {
			client.submitOrder.mockRejectedValue(
				new EasNetworkError(false, 'bulk upload', 'ECONNREFUSED')
			);

			await processDueEasDeclarations(deps());
			let d = await decl();
			expect(d).toMatchObject({ status: 'pending', attempts: 1 });
			expect(d.nextAttemptAt.getTime() - now.getTime()).toBe(60_000);

			advance(60_000);
			await processDueEasDeclarations(deps());
			d = await decl();
			expect(d).toMatchObject({ status: 'pending', attempts: 2 });
			expect(d.nextAttemptAt.getTime() - now.getTime()).toBe(120_000);

			for (let i = 2; i < MAX_SEND_ATTEMPTS; i++) {
				advance(6 * 3600_000);
				await processDueEasDeclarations(deps());
			}
			d = await decl();
			expect(d.status).toBe('failed');
			expect(client.submitOrder).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS);

			const [alert, ...more] = await alerts();
			expect(more).toEqual([]);
			expect(alert.dest).toBe('owner@shop.example');
			expect(alert.subject).toBe(`EAS test: order #${order.number} failed`);
			expect(alert.htmlContent).not.toMatch(/Ada|Lovelace|Hauptstra|ada@example/);

			advance(6 * 3600_000);
			await processDueEasDeclarations(deps());
			expect(client.submitOrder).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS);
		});

		it('retries when the token cannot be obtained, without claiming the send', async () => {
			client.authenticate.mockRejectedValueOnce(new EasNetworkError(true, 'token', 'TimeoutError'));
			await processDueEasDeclarations(deps());
			expect(client.submitOrder).not.toHaveBeenCalled();
			expect(await decl()).toMatchObject({ status: 'pending', attempts: 1 });
		});

		it.each([
			['a timeout', new EasNetworkError(true, 'bulk upload', 'TimeoutError')],
			['an HTTP 500', new EasHttpError(500, { message: 'oops' }, 'bulk upload')],
			['a 2xx without job id', new EasNetworkError(true, 'bulk upload', 'no job_id in response')]
		])('never resends after %s: the order may be declared already', async (_, err) => {
			client.submitOrder.mockRejectedValue(err);
			await processDueEasDeclarations(deps());
			expect(await decl()).toMatchObject({ status: 'needs_review' });
			expect((await decl()).reason).toMatch(/outcome of the send is unknown/);
			expect(await alerts()).toHaveLength(1);

			advance(24 * 3600_000);
			await processDueEasDeclarations(deps());
			expect(client.submitOrder).toHaveBeenCalledTimes(1);
		});

		it('flags a send interrupted by a crash, and does not resend it', async () => {
			await collections.easDeclarations.updateOne(
				{ environment: 'test' },
				{
					$set: {
						status: 'submitting',
						updatedAt: new Date(now.getTime() - SUBMITTING_STALE_MS - 1)
					}
				}
			);
			await processDueEasDeclarations(deps());
			expect(await decl()).toMatchObject({ status: 'needs_review' });
			expect(client.submitOrder).not.toHaveBeenCalled();
		});

		it('records a rejection by EAS, alerts, and does not loop', async () => {
			const error = {
				message: 'Sorry, duplicate item Ids found',
				code: 400,
				type: 'STOP_SELLING',
				data: [{ field: 'id_provided_by_em', type: 'ERR_VALIDATION' }]
			};
			client.getOrderResults.mockResolvedValue([
				{ external_order_id: String(order.number), status: 'rejected', error }
			]);
			await processDueEasDeclarations(deps());
			advance(31_000);
			await processDueEasDeclarations(deps());

			const d = await decl();
			expect(d).toMatchObject({ status: 'rejected', easError: error });
			expect(d.reason).toBe('rejected by EAS (job 9001, STOP_SELLING, code 400)');
			expect(await alerts()).toHaveLength(1);

			advance(24 * 3600_000);
			await processDueEasDeclarations(deps());
			expect(client.submitOrder).toHaveBeenCalledTimes(1);
			expect(client.getOrderResults).toHaveBeenCalledTimes(1);
		});

		it('records a file refused by EAS validation (HTTP 400) as rejected', async () => {
			client.submitOrder.mockRejectedValue(
				new EasHttpError(
					400,
					{ message: 'Error while parsing JSON', type: 'CONTACT_ADMIN' },
					'bulk upload'
				)
			);
			await processDueEasDeclarations(deps());
			expect(await decl()).toMatchObject({ status: 'rejected' });
			expect((await decl()).reason).toBe(
				'refused by EAS before processing: EAS bulk upload: HTTP 400 CONTACT_ADMIN'
			);
		});

		it('keeps polling when a status read fails', async () => {
			client.getJobStatus.mockRejectedValueOnce(new EasHttpError(503, null, 'job status'));
			await processDueEasDeclarations(deps());
			advance(31_000);
			await processDueEasDeclarations(deps());
			expect(await decl()).toMatchObject({ status: 'submitted', attempts: 1 });
			advance(61_000);
			await processDueEasDeclarations(deps());
			expect(await decl()).toMatchObject({ status: 'successful' });
		});

		it('skips a B2B order without sending nor alerting', async () => {
			const b2b = await placePaidOrder('FR', [{ product: CARD, quantity: 1 }], {
				vatNumber: 'FR12345678901'
			});
			now = new Date();
			await processDueEasDeclarations(deps());
			const d = await collections.easDeclarations.findOne({
				environment: 'test',
				externalOrderId: String(b2b.number)
			});
			expect(d).toMatchObject({
				status: 'skipped',
				reason: 'B2B order (company or VAT number given)'
			});
			expect(client.submitOrder).toHaveBeenCalledTimes(1); // only the German order
			expect(await alerts()).toEqual([]);
		});

		it('puts an order above 150 EUR in review, and alerts', async () => {
			// At most 10 of a product per order: 4 × 10 cards × 5 CHF = 200 CHF (1 CHF = 1 EUR in tests)
			const more = [2, 3].map((i) => ({ ...CARD, _id: `card-${i}`, alias: [`card-${i}`] }));
			await collections.products.insertMany(more);
			const big = await placePaidOrder(
				'DE',
				[CARD, OTHER_CARD, ...more].map((product) => ({ product, quantity: 10 }))
			);
			now = new Date();
			await processDueEasDeclarations(deps());
			const d = await collections.easDeclarations.findOne({
				environment: 'test',
				externalOrderId: String(big.number)
			});
			expect(d?.status).toBe('needs_review');
			expect(d?.reason).toMatch(/above 150 EUR/);
			const [alert] = await alerts();
			expect(alert.subject).toBe(`EAS test: order #${big.number} needs review`);
		});
	});
});
