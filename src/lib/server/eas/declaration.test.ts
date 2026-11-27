import { describe, expect, it } from 'vitest';
import type { Order } from '$lib/types/Order';
import type { CountryAlpha2 } from '$lib/types/Country';
import {
	buildEasDeclaration,
	easSaleDate,
	EU_COUNTRIES,
	type EasDeclarationContext,
	type EasOrderEntry
} from './declaration';

const PAID_AT = new Date('2026-11-27T13:05:09.123Z');

/** CHF → EUR at about the rate of late 2026 */
const ctx: EasDeclarationContext = {
	sellerCountry: 'CH',
	toEur: (amount, currency) =>
		currency === 'CHF' ? Math.round(amount * 1.0934 * 100) / 100 : undefined
};

/**
 * An order as be-BOP stores it: item prices without VAT, the VAT of the whole order (delivery
 * included) per rate, rounded once, and the total paid.
 */
function makeOrder(params: {
	country: CountryAlpha2;
	rate: number;
	lines: Array<{ id: string; quantity: number; unit?: number }>;
	delivery?: number;
	vat: number;
	total: number;
	overrides?: Partial<Order>;
}): Order {
	const chf = (amount: number) => ({ amount, currency: 'CHF' as const });
	return {
		_id: 'order-id',
		number: 1042,
		status: 'paid',
		locale: 'en',
		items: params.lines.map((line) => ({
			product: { _id: line.id, name: `Card ${line.id}`, shipping: true },
			quantity: line.quantity,
			vatRate: params.rate,
			currencySnapshot: {
				main: { price: chf(line.unit ?? 5) },
				priceReference: { price: chf(line.unit ?? 5) }
			}
		})),
		shippingAddress: {
			firstName: 'Ada',
			lastName: 'Lovelace',
			address: '12 Hauptstraße\nApt 3',
			city: 'Berlin',
			zip: '10115',
			country: params.country,
			phone: '+49 30 1234567'
		},
		shippingPrice: chf(params.delivery ?? 8),
		vat: [{ rate: params.rate, country: params.country }],
		currencySnapshot: {
			main: {
				totalPrice: chf(params.total),
				shippingPrice: chf(params.delivery ?? 8),
				vat: [chf(params.vat)]
			},
			priceReference: { totalPrice: chf(params.total) }
		},
		payments: [{ status: 'paid', paidAt: PAID_AT, method: 'lightning' }],
		notifications: { paymentStatus: { email: 'ada@example.com' } },
		user: {},
		...params.overrides
	} as unknown as Order;
}

function declared(order: Order): EasOrderEntry {
	const decision = buildEasDeclaration(order, ctx);
	if (decision.kind !== 'declare') {
		throw new Error(`expected a declaration, got ${decision.kind}: ${decision.reason}`);
	}
	return decision.entry;
}

/** What the declaration says the customer paid, in cents */
function declaredTotalCents(entry: EasOrderEntry): number {
	const lines = entry.order.order_breakdown;
	return Math.round(
		lines.reduce(
			(sum, l) =>
				sum +
				l.unit_cost * l.quantity +
				l.item_vat +
				l.item_delivery_charge +
				l.item_delivery_charge_vat,
			0
		) * 100
	);
}

describe('buildEasDeclaration: amounts', () => {
	it('declares three cards to Germany with delivery, as paid', () => {
		// 3 × 5 + 8 = 23 CHF without VAT, 19 % → 4.37, total 27.37
		const entry = declared(
			makeOrder({
				country: 'DE',
				rate: 19,
				lines: [{ id: 'zap', quantity: 3 }],
				vat: 4.37,
				total: 27.37
			})
		);

		expect(entry.order.payment_currency).toBe('CHF');
		expect(entry.order.total_order_amount).toBe(27.37);
		expect(entry.order.delivery_cost).toBe(9.52);
		expect(entry.order.order_breakdown).toEqual([
			{
				id_provided_by_em: 'zap',
				short_description: 'Card zap',
				long_description: '',
				quantity: 3,
				unit_cost: 5,
				vat_rate: 19,
				item_vat: 2.85,
				item_delivery_charge: 8,
				item_delivery_charge_vat: 1.52,
				weight: 0.006,
				hs6p_received: '852352',
				type_of_goods: 'goods',
				originating_country: 'CN',
				location_warehouse_country: 'CN',
				seller_registration_country: 'CH',
				reduced_tbe_vat_group: false,
				act_as_disclosed_agent: false
			}
		]);
		expect(declaredTotalCents(entry)).toBe(2737);
	});

	it('splits the VAT between several lines and the delivery (France, 20 %)', () => {
		// 2 × 5 + 1 × 5 + 8 = 23, VAT 4.60
		const entry = declared(
			makeOrder({
				country: 'FR',
				rate: 20,
				lines: [
					{ id: 'zap', quantity: 2 },
					{ id: 'seed', quantity: 1 }
				],
				vat: 4.6,
				total: 27.6
			})
		);
		const lines = entry.order.order_breakdown;
		expect(
			lines.map((l) => [
				l.id_provided_by_em,
				l.item_vat,
				l.item_delivery_charge,
				l.item_delivery_charge_vat
			])
		).toEqual([
			['zap', 2, 8, 1.6],
			['seed', 1, 0, 0]
		]);
		expect(declaredTotalCents(entry)).toBe(2760);
	});

	it('uses the rate of the delivery country (Hungary, 27 %)', () => {
		const entry = declared(
			makeOrder({
				country: 'HU',
				rate: 27,
				lines: [{ id: 'seed', quantity: 1 }],
				vat: 3.51,
				total: 16.51
			})
		);
		expect(entry.order.delivery_country).toBe('HU');
		expect(entry.order.order_breakdown[0]).toMatchObject({
			vat_rate: 27,
			item_vat: 1.35,
			item_delivery_charge_vat: 2.16
		});
		expect(declaredTotalCents(entry)).toBe(1651);
	});

	it('splits a VAT that was rounded once to the cent, without losing or adding a cent (Finland, 25.5 %)', () => {
		// 3 lines of 5 + 8 = 23, VAT 5.865 → 5.87 stored, total 28.87
		const entry = declared(
			makeOrder({
				country: 'FI',
				rate: 25.5,
				lines: [
					{ id: 'zap', quantity: 1 },
					{ id: 'seed', quantity: 1 },
					{ id: 'tick-tock', quantity: 1 }
				],
				vat: 5.87,
				total: 28.87
			})
		);
		const vats = entry.order.order_breakdown.map((l) => l.item_vat);
		expect(vats).toEqual([1.28, 1.28, 1.27]);
		expect(entry.order.order_breakdown[0].item_delivery_charge_vat).toBe(2.04);
		expect(Math.round((vats.reduce((a, b) => a + b) + 2.04) * 100)).toBe(587);
		expect(declaredTotalCents(entry)).toBe(2887);
	});

	it('declares a free delivery', () => {
		const entry = declared(
			makeOrder({
				country: 'DE',
				rate: 19,
				lines: [{ id: 'zap', quantity: 2 }],
				delivery: 0,
				vat: 1.9,
				total: 11.9
			})
		);
		expect(entry.order.delivery_cost).toBe(0);
		expect(entry.order.order_breakdown[0]).toMatchObject({
			item_delivery_charge: 0,
			item_delivery_charge_vat: 0,
			item_vat: 1.9
		});
	});

	it('needs review rather than rounding when the amounts do not add up to the total paid', () => {
		const decision = buildEasDeclaration(
			makeOrder({
				country: 'DE',
				rate: 19,
				lines: [{ id: 'zap', quantity: 3 }],
				vat: 4.37,
				total: 27.38
			}),
			ctx
		);
		expect(decision).toEqual({
			kind: 'needs_review',
			reason: 'items, delivery and VAT do not add up exactly to the total paid'
		});
	});

	it('needs review when the stored VAT is not the VAT of these prices', () => {
		const decision = buildEasDeclaration(
			makeOrder({
				country: 'DE',
				rate: 19,
				lines: [{ id: 'zap', quantity: 3 }],
				vat: 4.4,
				total: 27.4
			}),
			ctx
		);
		expect(decision.kind).toBe('needs_review');
	});

	it('needs review when a unit price has sub-cent decimals that cannot add up exactly', () => {
		const decision = buildEasDeclaration(
			makeOrder({
				country: 'DE',
				rate: 19,
				lines: [{ id: 'zap', quantity: 1, unit: 4.20168067 }],
				vat: 2.32,
				total: 14.52
			}),
			ctx
		);
		expect(decision.kind).toBe('needs_review');
	});
});

describe('buildEasDeclaration: order fields', () => {
	const order = makeOrder({
		country: 'DE',
		rate: 19,
		lines: [{ id: 'zap', quantity: 3 }],
		vat: 4.37,
		total: 27.37
	});

	it('fills the delivery, recipient and sale fields', () => {
		const entry = declared(order);
		expect(entry.s10_code).toBe('1042');
		expect(entry.sale_date).toBe('2026-11-27T13:05:09+00:00');
		expect(entry.order).toMatchObject({
			external_order_id: '1042',
			recipient_title: '',
			recipient_first_name: 'Ada',
			recipient_last_name: 'Lovelace',
			is_delivery_to_person: true,
			recipient_company_name: '',
			recipient_company_vat: '',
			delivery_address_line_1: '12 Hauptstraße',
			delivery_address_line_2: 'Apt 3',
			delivery_city: 'Berlin',
			delivery_postal_code: '10115',
			delivery_state_province: '',
			delivery_country: 'DE',
			delivery_email: 'ada@example.com',
			delivery_phone: '+49 30 1234567',
			delivery_method: 'postal'
		});
	});

	it('takes the date of the last payment', () => {
		const later = new Date('2026-11-28T08:00:00Z');
		const entry = declared({
			...order,
			payments: [
				{ status: 'paid', paidAt: PAID_AT },
				{ status: 'paid', paidAt: later },
				{ status: 'expired', paidAt: new Date('2026-12-01T00:00:00Z') }
			]
		} as unknown as Order);
		expect(entry.sale_date).toBe(easSaleDate(later));
	});

	it('gives each line a distinct id when a product appears twice', () => {
		const entry = declared(
			makeOrder({
				country: 'DE',
				rate: 19,
				lines: [
					{ id: 'zap', quantity: 1 },
					{ id: 'zap', quantity: 2 }
				],
				vat: 4.37,
				total: 27.37
			})
		);
		expect(entry.order.order_breakdown.map((l) => l.id_provided_by_em)).toEqual(['zap', 'zap#2']);
	});

	it('uses the account e-mail when the order has no notification e-mail', () => {
		const entry = declared({
			...order,
			notifications: { paymentStatus: {} },
			user: { email: 'account@example.com' }
		} as unknown as Order);
		expect(entry.order.delivery_email).toBe('account@example.com');
	});

	it('does not mutate the order', () => {
		const copy = structuredClone(order);
		buildEasDeclaration(order, ctx);
		expect(order).toEqual(copy);
	});
});

describe('buildEasDeclaration: which orders are IOSS sales', () => {
	const base = { rate: 19, lines: [{ id: 'zap', quantity: 3 }], vat: 4.37, total: 27.37 };

	it('knows the 27 EU countries, and only them', () => {
		expect(EU_COUNTRIES.size).toBe(27);
		for (const country of ['GB', 'CH', 'NO', 'IS', 'LI', 'MC', 'US', 'XI']) {
			expect(EU_COUNTRIES.has(country)).toBe(false);
		}
	});

	it.each(['CH', 'GB', 'NO', 'US'] as CountryAlpha2[])('skips a delivery to %s', (country) => {
		expect(buildEasDeclaration(makeOrder({ ...base, country }), ctx)).toEqual({
			kind: 'skipped',
			reason: 'delivery outside the EU'
		});
	});

	it('skips an order without delivery', () => {
		const order = makeOrder({ ...base, country: 'DE', overrides: { shippingAddress: undefined } });
		expect(buildEasDeclaration(order, ctx).kind).toBe('skipped');
	});

	it('skips a B2B order: VAT number or company, on the delivery or billing address', () => {
		const order = makeOrder({ ...base, country: 'DE' });
		const withShipping = (patch: object) =>
			({ ...order, shippingAddress: { ...order.shippingAddress, ...patch } }) as Order;
		const withBilling = (patch: object) =>
			({ ...order, billingAddress: { ...order.shippingAddress, ...patch } }) as Order;

		for (const b2b of [
			withShipping({ vatNumber: 'DE123456789' }),
			withShipping({ isCompany: true, companyName: 'ACME' }),
			withBilling({ vatNumber: 'DE123456789' }),
			withBilling({ isCompany: true })
		]) {
			expect(buildEasDeclaration(b2b, ctx)).toEqual({
				kind: 'skipped',
				reason: 'B2B order (company or VAT number given)'
			});
		}
		// An empty VAT number is not one
		expect(buildEasDeclaration(withShipping({ vatNumber: ' ' }), ctx).kind).toBe('declare');
	});

	it('needs review above 150 EUR of intrinsic value (goods without delivery nor VAT)', () => {
		// 28 cards × 5 CHF = 140 CHF ≈ 153.08 EUR
		const over = makeOrder({
			country: 'DE',
			rate: 19,
			lines: [{ id: 'zap', quantity: 28 }],
			vat: 28.12,
			total: 176.12
		});
		expect(buildEasDeclaration(over, ctx)).toEqual({
			kind: 'needs_review',
			reason: 'intrinsic value above 150 EUR: VAT was charged but IOSS does not apply'
		});
		// 27 cards = 135 CHF ≈ 147.61 EUR: the delivery does not count
		const under = makeOrder({
			country: 'DE',
			rate: 19,
			lines: [{ id: 'zap', quantity: 27 }],
			vat: 27.17,
			total: 170.17
		});
		expect(buildEasDeclaration(under, ctx)).toMatchObject({
			kind: 'declare',
			intrinsicValueEur: 147.61
		});
	});

	it('needs review without an exchange rate to EUR', () => {
		const decision = buildEasDeclaration(makeOrder({ ...base, country: 'DE' }), {
			...ctx,
			toEur: () => undefined
		});
		expect(decision).toEqual({ kind: 'needs_review', reason: 'no exchange rate from CHF to EUR' });
	});

	it('needs review without a customer e-mail, and never uses another address', () => {
		const order = makeOrder({
			...base,
			country: 'DE',
			overrides: {
				notifications: { paymentStatus: { npub: 'npub1xyz' } },
				user: {}
			} as Partial<Order>
		});
		expect(buildEasDeclaration(order, ctx)).toEqual({
			kind: 'needs_review',
			reason: 'no customer e-mail address, which EAS requires'
		});
	});

	it('needs review when no VAT was charged (shop VAT exemption)', () => {
		const order = makeOrder({
			...base,
			country: 'DE',
			overrides: { vat: undefined, vatFree: { reason: 'Not subject to VAT' } }
		});
		expect(buildEasDeclaration(order, ctx).kind).toBe('needs_review');
		const noVat = makeOrder({ ...base, country: 'DE', overrides: { vat: undefined } });
		expect(buildEasDeclaration(noVat, ctx)).toEqual({
			kind: 'needs_review',
			reason: 'the order was charged no VAT'
		});
	});

	it('needs review when the VAT is not the delivery country one', () => {
		const order = makeOrder({
			...base,
			country: 'DE',
			overrides: { vat: [{ rate: 8.1, country: 'CH' }] }
		});
		expect(buildEasDeclaration(order, ctx).kind).toBe('needs_review');
	});

	it('needs review for unpaid orders, discounts, free units, deposits and non-shipped items', () => {
		const order = makeOrder({ ...base, country: 'DE' });
		const variants: Order[] = [
			{ ...order, status: 'pending' },
			{
				...order,
				discount: { justification: 'x', type: 'fiat', price: { amount: 1, currency: 'CHF' } }
			},
			{ ...order, items: [{ ...order.items[0], freeQuantity: 1 }] },
			{ ...order, items: [{ ...order.items[0], depositPercentage: 50 }] },
			{
				...order,
				items: [{ ...order.items[0], product: { ...order.items[0].product, shipping: false } }]
			}
		];
		for (const variant of variants) {
			expect(buildEasDeclaration(variant, ctx).kind).toBe('needs_review');
		}
	});

	it('needs review when amounts are in bitcoin', () => {
		const order = makeOrder({ ...base, country: 'DE' });
		const btc = {
			...order,
			currencySnapshot: {
				...order.currencySnapshot,
				main: { ...order.currencySnapshot.main, totalPrice: { amount: 0.0005, currency: 'BTC' } }
			}
		} as Order;
		expect(buildEasDeclaration(btc, ctx).kind).toBe('needs_review');
	});

	it("needs review without the shop's country", () => {
		const decision = buildEasDeclaration(makeOrder({ ...base, country: 'DE' }), {
			...ctx,
			sellerCountry: undefined
		});
		expect(decision.kind).toBe('needs_review');
	});
});
