import { writable } from 'svelte/store';
import type { Currency } from '$lib/types/Currency';
import type { LayoutData } from '../../routes/(app)/$types';

export const currencies = writable<LayoutData['currencies']>({
	main: 'BTC',
	secondary: 'EUR',
	priceReference: 'SAT'
});

/**
 * Fiat currency of the visitor's country, in which the storefront displays fiat prices.
 * Null where amounts keep the shop's currencies (admin, POS, orders) or when unknown.
 */
export const visitorCurrency = writable<Currency | null>(null);

/**
 * Exchange rates for amounts converted to `visitorCurrency`, when they must not follow the live
 * rates: the ones stored on an order, for its page and invoice. Null means the live rates.
 */
export const visitorRates = writable<Record<string, number> | null>(null);
