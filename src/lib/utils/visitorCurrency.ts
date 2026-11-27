import { getCurrencyFromCountry, isAlpha2CountryCode } from '$lib/types/Country';
import type { Currency } from '$lib/types/Currency';

function isBitcoin(currency: Currency): boolean {
	return currency === 'BTC' || currency === 'SAT';
}

/**
 * The fiat currency of the visitor's country, if prices can be converted to it.
 *
 * Returns null when the country is unknown, or when there is no exchange rate for its
 * currency (the conversion would silently fall back to the original amount otherwise).
 */
export function visitorCurrencyForCountry(
	countryCode: string | undefined,
	exchangeRate: Record<string, number>
): Currency | null {
	if (!countryCode || !isAlpha2CountryCode(countryCode)) {
		return null;
	}
	const currency = getCurrencyFromCountry(countryCode);
	if (!currency || isBitcoin(currency) || !exchangeRate[currency]) {
		return null;
	}
	return currency;
}

/**
 * Pages where amounts keep the shop's own currencies: back-office, point of sale, and
 * orders, payments and receipts, whose amounts are the ones actually owed and paid.
 */
const ROUTES_WITH_SHOP_CURRENCIES = ['/(app)/admin', '/(app)/pos', '/(app)/order', '/(app)/label'];

export function showsVisitorCurrency(routeId: string | null | undefined): boolean {
	if (!routeId) {
		return false;
	}
	return !ROUTES_WITH_SHOP_CURRENCIES.some((prefix) => routeId.startsWith(prefix));
}

/**
 * The currency a fiat amount is displayed in for this visitor.
 *
 * Bitcoin amounts are never touched. A fiat amount is shown in the visitor's currency,
 * except for the secondary price when the shop shows two fiat currencies: then it shows
 * the shop's currency that the main price no longer shows, so the two never repeat
 * (shop in CHF + EUR, visitor in France: EUR then CHF; visitor in Switzerland: CHF then EUR).
 */
export function localizedCurrency(
	currency: Currency,
	opts: {
		visitorCurrency: Currency | null;
		isSecondary: boolean;
		mainCurrency: Currency;
		secondaryCurrency: Currency | null;
	}
): Currency {
	const { visitorCurrency, isSecondary, mainCurrency, secondaryCurrency } = opts;
	if (!visitorCurrency || isBitcoin(currency)) {
		return currency;
	}
	if (
		isSecondary &&
		secondaryCurrency &&
		!isBitcoin(mainCurrency) &&
		!isBitcoin(secondaryCurrency)
	) {
		return visitorCurrency === mainCurrency ? secondaryCurrency : mainCurrency;
	}
	return visitorCurrency;
}

/**
 * Stored on an order: the customer's currency and the rates of that moment, so their order page
 * and invoice always show the same amounts. Rates are units per bitcoin, like `exchangeRate`.
 */
export interface VisitorCurrencySnapshot {
	currency: Currency;
	exchangeRate: Record<string, number>;
}

/**
 * Snapshot of the visitor's currency for a new order, or null when there is nothing to convert:
 * no visitor currency, no rate for it, or it already is the shop's main currency.
 */
export function snapshotVisitorCurrency(
	visitorCurrency: Currency | null | undefined,
	shopCurrencies: { main: Currency; others: Array<Currency | null | undefined> },
	exchangeRate: Record<string, number>
): VisitorCurrencySnapshot | null {
	if (
		!visitorCurrency ||
		isBitcoin(visitorCurrency) ||
		!exchangeRate[visitorCurrency] ||
		visitorCurrency === shopCurrencies.main
	) {
		return null;
	}
	const codes = new Set<string>([
		visitorCurrency,
		shopCurrencies.main,
		...shopCurrencies.others.filter((c): c is Currency => !!c),
		'SAT'
	]);
	return {
		currency: visitorCurrency,
		exchangeRate: Object.fromEntries(
			[...codes].filter((c) => c !== 'BTC' && exchangeRate[c]).map((c) => [c, exchangeRate[c]])
		)
	};
}

/**
 * The currency fiat amounts are displayed in, and the rates to use (null: the live rates).
 */
export interface DisplayCurrency {
	currency: Currency | null;
	rates: Record<string, number> | null;
}

export const NO_DISPLAY_CURRENCY: DisplayCurrency = { currency: null, rates: null };

/**
 * How an order is displayed to its customer: in the currency stored on the order at its rates,
 * or, for orders placed before it was stored, in the visitor's currency at today's rates when
 * `live` is given (the order page), or in the shop's currencies (the invoice, given no `live`).
 */
export function orderDisplayCurrency(
	order: { visitorCurrency?: VisitorCurrencySnapshot },
	live?: Currency | null
): DisplayCurrency {
	if (order.visitorCurrency) {
		return { currency: order.visitorCurrency.currency, rates: order.visitorCurrency.exchangeRate };
	}
	return { currency: live ?? null, rates: null };
}
