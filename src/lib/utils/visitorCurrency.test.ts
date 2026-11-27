import { describe, expect, it } from 'vitest';
import {
	localizedCurrency,
	orderDisplayCurrency,
	showsVisitorCurrency,
	snapshotVisitorCurrency,
	visitorCurrencyForCountry
} from './visitorCurrency';
import { toCurrency } from './toCurrency';

const rates = { CHF: 80_000, EUR: 85_000, USD: 95_000, SAT: 100_000_000 };

describe('visitorCurrencyForCountry', () => {
	it("gives the currency of the visitor's country", () => {
		expect(visitorCurrencyForCountry('FR', rates)).toBe('EUR');
		expect(visitorCurrencyForCountry('CH', rates)).toBe('CHF');
		expect(visitorCurrencyForCountry('US', rates)).toBe('USD');
	});

	it('gives nothing for an unknown country', () => {
		expect(visitorCurrencyForCountry(undefined, rates)).toBeNull();
		expect(visitorCurrencyForCountry('XX', rates)).toBeNull();
	});

	it('gives nothing when there is no exchange rate for that currency', () => {
		expect(visitorCurrencyForCountry('JP', rates)).toBeNull();
	});
});

describe('showsVisitorCurrency', () => {
	it('applies to the storefront', () => {
		expect(showsVisitorCurrency('/(app)')).toBe(true);
		expect(showsVisitorCurrency('/(app)/product/[id]')).toBe(true);
		expect(showsVisitorCurrency('/(app)/cart')).toBe(true);
		expect(showsVisitorCurrency('/(app)/checkout')).toBe(true);
		expect(showsVisitorCurrency('/(app)/[slug]')).toBe(true);
	});

	it('keeps the shop currencies in admin, POS, orders and receipts', () => {
		expect(showsVisitorCurrency('/(app)/admin[[hash=admin_hash]]/product/[id]')).toBe(false);
		expect(showsVisitorCurrency('/(app)/pos/touch/tab/[orderTabSlug]')).toBe(false);
		expect(showsVisitorCurrency('/(app)/order/[id]')).toBe(false);
		expect(showsVisitorCurrency('/(app)/order/[id]/payment/[paymentId]/receipt')).toBe(false);
		expect(showsVisitorCurrency('/(app)/orders')).toBe(false);
		expect(showsVisitorCurrency(null)).toBe(false);
	});
});

describe('localizedCurrency', () => {
	const chfBtc = { mainCurrency: 'CHF', secondaryCurrency: 'BTC' } as const;
	const chfEur = { mainCurrency: 'CHF', secondaryCurrency: 'EUR' } as const;

	it('shows fiat amounts in the visitor currency', () => {
		const opts = { ...chfBtc, visitorCurrency: 'EUR', isSecondary: false } as const;
		expect(localizedCurrency('CHF', opts)).toBe('EUR');
		expect(localizedCurrency('USD', opts)).toBe('EUR');
	});

	it('never touches bitcoin amounts', () => {
		const opts = { ...chfBtc, visitorCurrency: 'EUR', isSecondary: true } as const;
		expect(localizedCurrency('BTC', opts)).toBe('BTC');
		expect(localizedCurrency('SAT', opts)).toBe('SAT');
	});

	it('changes nothing when the visitor currency is unknown', () => {
		const opts = { ...chfBtc, visitorCurrency: null, isSecondary: false } as const;
		expect(localizedCurrency('CHF', opts)).toBe('CHF');
	});

	it('never shows the same fiat currency twice when the shop shows two', () => {
		expect(
			localizedCurrency('CHF', { ...chfEur, visitorCurrency: 'EUR', isSecondary: false })
		).toBe('EUR');
		expect(localizedCurrency('EUR', { ...chfEur, visitorCurrency: 'EUR', isSecondary: true })).toBe(
			'CHF'
		);
		expect(
			localizedCurrency('CHF', { ...chfEur, visitorCurrency: 'CHF', isSecondary: false })
		).toBe('CHF');
		expect(localizedCurrency('EUR', { ...chfEur, visitorCurrency: 'CHF', isSecondary: true })).toBe(
			'EUR'
		);
		expect(localizedCurrency('EUR', { ...chfEur, visitorCurrency: 'USD', isSecondary: true })).toBe(
			'CHF'
		);
	});
});

describe('snapshotVisitorCurrency', () => {
	const shop = { main: 'CHF', others: ['BTC', 'CHF', null] } as const;

	it("keeps the visitor's currency with the rates needed to convert the order", () => {
		expect(
			snapshotVisitorCurrency('EUR', { main: 'CHF', others: [...shop.others] }, rates)
		).toEqual({
			currency: 'EUR',
			exchangeRate: { EUR: 85_000, CHF: 80_000, SAT: 100_000_000 }
		});
	});

	it('stores nothing when there is nothing to convert', () => {
		const s = { main: 'CHF' as const, others: [...shop.others] };
		expect(snapshotVisitorCurrency('CHF', s, rates)).toBeNull();
		expect(snapshotVisitorCurrency(null, s, rates)).toBeNull();
		expect(snapshotVisitorCurrency('JPY', s, rates)).toBeNull();
	});
});

describe('orderDisplayCurrency', () => {
	const visitorCurrency = { currency: 'EUR' as const, exchangeRate: { EUR: 85_000, CHF: 80_000 } };

	it("shows an order in the currency and at the rates stored on it, whoever's looking", () => {
		expect(orderDisplayCurrency({ visitorCurrency }, 'USD')).toEqual({
			currency: 'EUR',
			rates: { EUR: 85_000, CHF: 80_000 }
		});
	});

	it("shows older orders in today's visitor currency, or in the shop's on the invoice", () => {
		expect(orderDisplayCurrency({}, 'USD')).toEqual({ currency: 'USD', rates: null });
		expect(orderDisplayCurrency({})).toEqual({ currency: null, rates: null });
	});
});

describe('toCurrency with frozen rates', () => {
	it('converts at the rates given, not the live ones', () => {
		// 13 CHF at 80,000 CHF/BTC and 85,000 EUR/BTC
		expect(toCurrency('EUR', 13, 'CHF', { EUR: 85_000, CHF: 80_000 })).toBe(13.81);
	});
});
