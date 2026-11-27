<script lang="ts">
	import {
		FRACTION_DIGITS_PER_CURRENCY,
		SATOSHIS_PER_BTC,
		type Currency
	} from '$lib/types/Currency';
	import { toCurrency } from '$lib/utils/toCurrency';
	import IconBitcoin from './icons/IconBitcoin.svelte';
	import IconSatoshi from './icons/IconSatoshi.svelte';
	import { currencies, visitorCurrency, visitorRates } from '$lib/stores/currencies';
	import { localizedCurrency } from '$lib/utils/visitorCurrency';

	export let amount: number;
	export let currency: Currency;
	export let convertedTo: Currency | undefined = undefined;
	export let force = false;
	/**
	 * Convert to the main currency
	 */
	export let main = false;
	/**
	 * Convert to the secondary currency
	 */
	export let secondary = false;
	export let short = true;
	export let inline = false;
	export let gap = 'gap-2';

	let className = '';
	export { className as class };

	const mainCurrency = $currencies.main;
	const secondaryCurrency = $currencies.secondary;

	$: shopCurrency = (
		main ? mainCurrency : secondary ? secondaryCurrency : convertedTo ?? currency
	) as Currency | null;
	// Fiat amounts are shown in the visitor's currency on the storefront (see visitorCurrency store)
	$: actualCurrency =
		shopCurrency &&
		localizedCurrency(shopCurrency, {
			visitorCurrency: $visitorCurrency,
			isSecondary: secondary,
			mainCurrency,
			secondaryCurrency
		});
	$: converted = !!shopCurrency && actualCurrency !== shopCurrency;
	$: actualAmount =
		actualCurrency === null
			? 0
			: toCurrency(actualCurrency, amount, currency, converted ? $visitorRates : null);

	// Auto-conversion thresholds: small BTC amounts show as SAT, large SAT amounts show as BTC
	$: [displayedAmount, displayedCurrency] = (() => {
		if (!force && actualCurrency === 'BTC' && actualAmount < 0.01) {
			return [actualAmount * SATOSHIS_PER_BTC, 'SAT'] as const;
		}
		if (!force && actualCurrency === 'SAT' && actualAmount >= 1_000_000) {
			return [actualAmount / SATOSHIS_PER_BTC, 'BTC'] as const;
		}
		return [actualAmount, actualCurrency || 'BTC'] as const;
	})() as [number, Currency];

	// Helper: check if currency is crypto (SAT or BTC)
	$: isCrypto = displayedCurrency === 'SAT' || displayedCurrency === 'BTC';

	// Determine decimal places based on currency
	$: maximumFractionDigits = FRACTION_DIGITS_PER_CURRENCY[displayedCurrency];

	$: minimumFractionDigits =
		!Number.isInteger(displayedAmount) && !isCrypto ? maximumFractionDigits : 0;

	// Edge case: very small fiat amounts (> 0 but < 0.01) show as "< 0.01"
	$: isSmallFiatAmount = !isCrypto && actualAmount > 0 && displayedAmount < 0.01;

	// Build small formatting config - crypto gets no currency symbol, fiat gets it
	$: formatConfig = {
		maximumFractionDigits,
		minimumFractionDigits,
		...(isCrypto ? {} : { style: 'currency' as const, currency: displayedCurrency })
	} satisfies Intl.NumberFormatOptions;

	$: formattedAmount = isSmallFiatAmount
		? (0.01).toLocaleString('en', { style: 'currency', currency: displayedCurrency })
		: displayedAmount.toLocaleString('en', formatConfig);

	$: displayed = isSmallFiatAmount
		? `< ${formattedAmount}`
		: `${formattedAmount}${displayedCurrency === 'SAT' && !short ? ' SAT' : ''}`;

	// When converted for the visitor, the hover text gives the shop's own price
	$: title =
		converted && shopCurrency
			? `${displayed} ≈ ${toCurrency(shopCurrency, amount, currency).toLocaleString('en', {
					style: 'currency',
					currency: shopCurrency,
					maximumFractionDigits: FRACTION_DIGITS_PER_CURRENCY[shopCurrency]
			  })}`
			: displayed;
</script>

{#if actualCurrency}
	<div class="{className} {inline ? 'inline-flex' : 'flex'} {gap} items-center" {title}>
		{#if displayedCurrency === 'SAT'}
			<IconSatoshi class="min-w-[1em]" />
		{:else if displayedCurrency === 'BTC'}
			<IconBitcoin class="min-w-[1em]" />
		{/if}

		{displayed}

		<slot />
	</div>
{/if}
