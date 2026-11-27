import { exchangeRate } from '$lib/stores/exchangeRate';
import { FRACTION_DIGITS_PER_CURRENCY, type Currency } from '$lib/types/Currency';
import { get } from 'svelte/store';

/**
 * @param frozenRates Rates to use instead of the live ones where they have them (units per
 *   bitcoin), e.g. the ones stored on an order
 */
export function toCurrency(
	targetCurrency: Currency,
	amount: number,
	fromCurrency: Currency,
	frozenRates?: Record<string, number> | null
): number {
	// Just fix the rounding if the currencies are the same
	if (fromCurrency === targetCurrency) {
		return roundToCurrency(amount, targetCurrency);
	}

	const rates: Record<string, number> = frozenRates
		? { ...get(exchangeRate), ...frozenRates }
		: get(exchangeRate);
	const fromRate = fromCurrency === 'BTC' ? 1 : rates[fromCurrency];
	const toRate = targetCurrency === 'BTC' ? 1 : rates[targetCurrency];

	// If exchange rates not available yet, return amount as-is (rates fetched from API)
	if (fromRate === undefined || toRate === undefined) {
		return roundToCurrency(amount, targetCurrency);
	}

	const bitcoinAmount = fromCurrency === 'BTC' ? amount : amount / fromRate;
	const ret = targetCurrency === 'BTC' ? bitcoinAmount : bitcoinAmount * toRate;

	return roundToCurrency(ret, targetCurrency);
}

/**
 * Rounds half up to the currency's precision, as written in decimal: 10.455 CHF is 10.46, though
 * 10.455 * 100 is 1045.4999999999998 in floating point. 15 significant digits drop that error and
 * keep every digit of any real amount.
 */
function roundToCurrency(amount: number, currency: Currency): number {
	const factor = Math.pow(10, FRACTION_DIGITS_PER_CURRENCY[currency]);
	const minorUnits = amount * factor;
	// Beyond 15 digits, a double has no fractional digit left to round
	return (
		Math.round(Math.abs(minorUnits) < 1e15 ? Number(minorUnits.toPrecision(15)) : minorUnits) /
		factor
	);
}
