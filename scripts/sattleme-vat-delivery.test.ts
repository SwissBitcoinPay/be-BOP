import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDb } from '../src/lib/server/test-utils';
import { collections, db } from '../src/lib/server/database';
import { runtimeConfig } from '../src/lib/server/runtime-config';
import { createOrder } from '../src/lib/server/orders';
import { TEST_PHYSICAL_PRODUCT } from '../src/lib/server/seed/product';
import { buildEasDeclaration, EU_COUNTRIES } from '../src/lib/server/eas/declaration';
import { computePriceInfo } from '../src/lib/cart';
import { COUNTRY_ALPHA2S, type CountryAlpha2 } from '../src/lib/types/Country';
import type { Product } from '../src/lib/types/Product';
import type { RuntimeConfig } from '../src/lib/server/runtime-config';
import { toCurrency } from '../src/lib/utils/toCurrency';
import {
	applySettings,
	checkNoFallback,
	DELIVERY_COUNTRIES,
	EU_STANDARD_VAT_RATES,
	VAT_PROFILE_NAME
	// @ts-expect-error plain JavaScript script
} from './sattleme-vat-delivery.mjs';

const CARD: Product = {
	...TEST_PHYSICAL_PRODUCT,
	_id: 'zap',
	alias: ['zap'],
	name: 'Zap',
	price: { amount: 5, currency: 'CHF', precision: 8 },
	stock: undefined
};
const BOOK: Product = {
	...CARD,
	_id: 'satoshi-kids',
	alias: ['satoshi-kids'],
	name: 'Satoshi Kids',
	price: { amount: 18, currency: 'CHF', precision: 8 }
};

/** The production settings on 2026-11-27, before the script */
async function seedProductionLikeSettings() {
	const now = new Date();
	await collections.products.insertMany([CARD, BOOK]);
	await db.collection('runtimeConfig').insertMany([
		{ _id: 'vatExempted', data: true, updatedAt: now },
		{ _id: 'vatExemptionReason', data: 'Not subject to VAT', updatedAt: now },
		{ _id: 'vatSingleCountry', data: false, updatedAt: now },
		{ _id: 'vatCountry', data: 'CH', updatedAt: now },
		{
			_id: 'deliveryFees',
			data: {
				mode: 'flatFee',
				onlyPayHighest: false,
				applyFlatFeeToEachItem: false,
				deliveryFees: { default: { amount: 8, currency: 'CHF' } },
				allowFreeForPOS: false,
				vatIncludedReference: false,
				vatProfileId: null
			},
			updatedAt: now
		}
	] as never[]);
}

describe('sattle.me VAT and delivery settings script', () => {
	const saved = {
		mainCurrency: runtimeConfig.mainCurrency,
		priceReferenceCurrency: runtimeConfig.priceReferenceCurrency,
		vatExempted: runtimeConfig.vatExempted,
		vatSingleCountry: runtimeConfig.vatSingleCountry,
		vatNullOutsideSellerCountry: runtimeConfig.vatNullOutsideSellerCountry,
		vatCountry: runtimeConfig.vatCountry,
		deliveryFees: runtimeConfig.deliveryFees
	};

	beforeEach(async () => {
		await cleanDb();
		await seedProductionLikeSettings();
	});

	afterEach(() => {
		Object.assign(runtimeConfig, saved);
	});

	/** Puts the written settings in be-BOP's memory, as its change stream does in production */
	async function loadWrittenSettings() {
		const config = await db.collection('runtimeConfig').find().toArray();
		const byKey = Object.fromEntries(config.map((c) => [c._id, c.data]));
		Object.assign(runtimeConfig, {
			mainCurrency: 'CHF',
			priceReferenceCurrency: 'CHF',
			vatExempted: byKey.vatExempted,
			vatSingleCountry: byKey.vatSingleCountry,
			vatNullOutsideSellerCountry: false,
			vatCountry: byKey.vatCountry,
			deliveryFees: byKey.deliveryFees as RuntimeConfig['deliveryFees']
		});
	}

	it('lists the EU and the same countries as the EAS integration', () => {
		expect(Object.keys(EU_STANDARD_VAT_RATES).sort()).toEqual([...EU_COUNTRIES].sort());
		expect(DELIVERY_COUNTRIES).toHaveLength(35);
		expect(DELIVERY_COUNTRIES).not.toContain('GB');
	});

	it('writes nothing in a dry run', async () => {
		const { after, written } = await applySettings(db, { write: false });
		expect(written).toBe(false);
		expect(after.vat.vatExempted).toBe(false);
		expect(Object.keys(after.deliveryFees.deliveryFees)).toHaveLength(35);
		expect(await collections.vatProfiles.countDocuments()).toBe(0);
		expect(
			await db.collection('runtimeConfig').findOne({ _id: 'vatExempted' as never })
		).toMatchObject({ data: true });
		expect(await checkNoFallback(db)).toEqual([`no VAT profile "${VAT_PROFILE_NAME}"`]);
	});

	it('writes the profile on every product and the delivery fees, then lifts the exemption, once', async () => {
		await applySettings(db, { write: true });

		const profiles = await collections.vatProfiles.find().toArray();
		expect(profiles).toHaveLength(1);
		const [profile] = profiles;
		expect(profile.name).toBe('UE seule');
		// Every country be-BOP knows has a rate: none falls back to the built-in table
		expect(Object.keys(profile.rates).sort()).toEqual([...COUNTRY_ALPHA2S].sort());
		expect(profile.rates).toMatchObject({ DE: 19, HU: 27, FI: 25.5, GR: 24, LU: 17 });
		expect(profile.rates).toMatchObject({ CH: 0, LI: 0, US: 0, GB: 0, NO: 0, JP: 0, KR: 0 });
		expect(Object.values(profile.rates).filter((r) => r !== 0)).toHaveLength(27);

		for (const product of await collections.products.find().toArray()) {
			expect(product.vatProfileId).toEqual(profile._id);
		}
		const delivery = await db.collection('runtimeConfig').findOne({ _id: 'deliveryFees' as never });
		expect(delivery?.data).toEqual({
			mode: 'flatFee',
			onlyPayHighest: false,
			applyFlatFeeToEachItem: false,
			allowFreeForPOS: false,
			vatIncludedReference: false,
			vatProfileId: profile._id.toString(),
			deliveryFees: Object.fromEntries(
				DELIVERY_COUNTRIES.map((c: string) => [c, { amount: 8, currency: 'CHF' }])
			)
		});
		expect(
			await db.collection('runtimeConfig').findOne({ _id: 'vatExempted' as never })
		).toMatchObject({ data: false });
		expect(await checkNoFallback(db)).toEqual([]);

		// Twice: same profile, nothing more
		await applySettings(db, { write: true });
		expect(await collections.vatProfiles.find().toArray()).toEqual(
			profiles.map((p) => ({ ...p, updatedAt: expect.any(Date) }))
		);
	});

	it('reports anything that would still use the built-in table', async () => {
		await applySettings(db, { write: true });
		expect(await checkNoFallback(db)).toEqual([]);

		// A product created later in the admin, without the profile
		await collections.products.insertOne({ ...CARD, _id: 'new-card', alias: ['new-card'] });
		await collections.vatProfiles.updateOne({}, { $unset: { 'rates.GB': '' } });
		expect(await checkNoFallback(db)).toEqual([
			'the VAT profile has no rate for GB',
			'the VAT profile has other rates for GB',
			'products without the profile: new-card'
		]);
	});

	describe('orders placed through be-BOP with the written settings', () => {
		beforeEach(async () => {
			await applySettings(db, { write: true });
			await loadWrittenSettings();
		});

		async function order(country: CountryAlpha2) {
			const products = await collections.products.find().sort({ _id: -1 }).toArray();
			const orderId = await createOrder(
				[
					{ product: products[0], quantity: 3 },
					{ product: products[1], quantity: 1 }
				],
				'point-of-sale',
				{
					locale: 'en',
					user: { sessionId: 'test-session-id' },
					notifications: { paymentStatus: { email: 'ada@example.com' } },
					shippingAddress: {
						firstName: 'Ada',
						lastName: 'Lovelace',
						address: '1 Main Street',
						city: 'Somewhere',
						zip: '1000',
						country
					},
					userVatCountry: country
				}
			);
			const created = await collections.orders.findOne({ _id: orderId });
			if (!created) {
				throw new Error('order not created');
			}
			return created;
		}

		it.each([
			['DE', 19, 7.79],
			['HU', 27, 11.07],
			// 41 × 25.5 % = 10.455, rounded half up
			['FI', 25.5, 10.46],
			['FR', 20, 8.2]
		] as const)(
			'charges %s VAT at %s %% on the cards and the delivery',
			async (country, rate, vat) => {
				const created = await order(country);
				// 3 × 5 + 18 + 8 delivery = 41 CHF excluding VAT
				expect(created.items.map((i) => i.vatRate)).toEqual([rate, rate]);
				expect(created.vat).toEqual([{ rate, country }]);
				expect(created.currencySnapshot.main.vat?.[0].amount).toBe(vat);
				expect(created.currencySnapshot.main.totalPrice.amount).toBeCloseTo(41 + vat, 10);

				const decision = buildEasDeclaration(
					{
						...created,
						status: 'paid',
						payments: [{ ...created.payments[0], status: 'paid', paidAt: new Date() }]
					},
					{ sellerCountry: 'CH', toEur: (amount, currency) => toCurrency('EUR', amount, currency) }
				);
				expect(decision.kind).toBe('declare');
			}
		);

		it.each(['CH', 'LI', 'US', 'CA', 'AU', 'NO', 'JP', 'KR'] as const)(
			'charges no VAT to %s, and delivers there',
			async (country) => {
				const created = await order(country);
				expect(created.items.map((i) => i.vatRate)).toEqual([0, 0]);
				expect(created.currencySnapshot.main.vat?.map((v) => v.amount) ?? [0]).toEqual([0]);
				expect(created.currencySnapshot.main.totalPrice.amount).toBe(41);
			}
		);

		it('refuses delivery to the United Kingdom and to any unlisted country', async () => {
			for (const country of ['GB', 'BR', 'CN'] as const) {
				await expect(order(country)).rejects.toMatchObject({
					status: 400,
					body: { message: 'Some products are not available in your country' }
				});
			}
		});

		it('shows no VAT in the cart to a visitor from a country of the built-in table', async () => {
			// In the cart, before the address, be-BOP uses the visitor's IP country
			const products = await collections.products.find().toArray();
			const vatProfiles = await collections.vatProfiles.find().toArray();
			const cart = (userCountry: CountryAlpha2) =>
				computePriceInfo(
					products.map((product) => ({ product, quantity: 1 })),
					{
						bebopCountry: 'CH',
						deliveryFees: { amount: 8, currency: 'CHF' },
						deliveryFeesVatProfileId: runtimeConfig.deliveryFees.vatProfileId,
						deliveryFeesVatIncluded: false,
						freeProductUnits: {},
						userCountry,
						vatExempted: false,
						vatNullOutsideSellerCountry: false,
						vatSingleCountry: false,
						vatProfiles
					}
				);
			// The built-in table has GB 20 %, CH 8.1 %, US 10.5 %
			for (const country of ['GB', 'CH', 'US'] as const) {
				expect(cart(country).vat.map((v) => v.rate)).toEqual([0]);
				expect(cart(country).totalVat).toBe(0);
			}
			expect(cart('DE').vat.map((v) => v.rate)).toEqual([19]);
		});
	});
});
