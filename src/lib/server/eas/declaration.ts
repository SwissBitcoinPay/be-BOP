import { orderIndividualItemPrice, type Order, type OrderAddress } from '$lib/types/Order';
import { FRACTION_DIGITS_PER_CURRENCY, type Currency } from '$lib/types/Currency';
import type { CountryAlpha2 } from '$lib/types/Country';

/**
 * The 27 EU member states, by ISO 3166-1 alpha-2 code (Greece is GR, as in be-BOP and EAS).
 * Not the United Kingdom, Switzerland, Norway, nor any other EEA or customs-union country.
 *
 * Keep in sync with scripts/eas-backfill.mjs (a test checks it).
 */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
	'AT',
	'BE',
	'BG',
	'CY',
	'CZ',
	'DE',
	'DK',
	'EE',
	'ES',
	'FI',
	'FR',
	'GR',
	'HR',
	'HU',
	'IE',
	'IT',
	'LT',
	'LU',
	'LV',
	'MT',
	'NL',
	'PL',
	'PT',
	'RO',
	'SE',
	'SI',
	'SK'
]);

export function isEuCountry(country: string | undefined): boolean {
	return !!country && EU_COUNTRIES.has(country);
}

/** IOSS applies to consignments whose intrinsic value does not exceed this amount. */
export const IOSS_THRESHOLD_EUR = 150;

/**
 * What the shop sells and how it ships, the same for every product: NFC cards (NXP NTAG 424 DNA,
 * HS 8523.52 "smart cards"), 6 g each without packaging, made in and shipped from China.
 * EAS expects the weight per unit in the account's unit, kg for the test account.
 */
export const EAS_GOODS = {
	hs6: '852352',
	weightKgPerUnit: 0.006,
	originatingCountry: 'CN',
	warehouseCountry: 'CN'
} as const;

/** One order in the `order_list` of EAS's "post-sale without landed cost" bulk upload. */
export interface EasOrderEntry {
	order: {
		recipient_title: '';
		recipient_first_name: string;
		recipient_last_name: string;
		recipient_company_name: '';
		recipient_company_vat: '';
		is_delivery_to_person: true;
		delivery_address_line_1: string;
		delivery_address_line_2: string;
		delivery_city: string;
		delivery_state_province: string;
		delivery_postal_code: string;
		delivery_country: string;
		delivery_email: string;
		delivery_phone: string;
		delivery_method: 'postal';
		/** Delivery price including VAT */
		delivery_cost: number;
		payment_currency: Currency;
		external_order_id: string;
		/** Everything the customer paid: goods, delivery and VAT */
		total_order_amount: number;
		order_breakdown: Array<{
			id_provided_by_em: string;
			short_description: string;
			long_description: '';
			quantity: number;
			/** Price of one unit, without VAT */
			unit_cost: number;
			vat_rate: number;
			/** VAT of the whole line */
			item_vat: number;
			/** Delivery price without VAT carried by this line */
			item_delivery_charge: number;
			item_delivery_charge_vat: number;
			weight: number;
			hs6p_received: string;
			type_of_goods: 'goods';
			originating_country: string;
			location_warehouse_country: string;
			seller_registration_country: string;
			reduced_tbe_vat_group: false;
			act_as_disclosed_agent: false;
		}>;
	};
	s10_code: string;
	sale_date: string;
}

export type EasDecision =
	| { kind: 'declare'; entry: EasOrderEntry; intrinsicValueEur: number }
	/** Not an IOSS sale: nothing to declare */
	| { kind: 'skipped'; reason: string }
	/** Cannot be declared as is: a person must look at it */
	| { kind: 'needs_review'; reason: string };

export interface EasDeclarationContext {
	/** Country the shop is registered in (be-BOP's seller identity) */
	sellerCountry: CountryAlpha2 | undefined;
	/** Converts an amount to EUR at be-BOP's exchange rate, undefined if there is no rate */
	toEur: (amount: number, currency: Currency) => number | undefined;
}

/** Amounts in minor units (cents) are integers: anything else did not reconcile exactly. */
const EPSILON = 1e-6;

function hasB2bMark(address: OrderAddress | undefined): boolean {
	return !!address && (!!address.isCompany || !!address.vatNumber?.trim());
}

/** `2026-11-27T13:05:09+00:00`, the format of EAS's examples */
export function easSaleDate(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * Splits `total` minor units between `parts` in proportion, so that they add up to it exactly
 * (largest remainder). Returns null when the total is not within the parts' rounding range.
 */
function allocateMinorUnits(exactParts: number[], total: number): number[] | null {
	const floors = exactParts.map((part) => Math.floor(part + EPSILON));
	let remaining = total - floors.reduce((a, b) => a + b, 0);
	if (remaining < 0 || remaining > exactParts.length) {
		return null;
	}
	const byRemainder = exactParts
		.map((part, i) => ({ i, remainder: part - floors[i] }))
		.sort((a, b) => b.remainder - a.remainder || a.i - b.i);
	for (const { i } of byRemainder) {
		if (remaining <= 0) {
			break;
		}
		floors[i] += 1;
		remaining -= 1;
	}
	return floors;
}

/**
 * Decides whether a paid be-BOP order is an IOSS sale to declare to EAS and, if so, builds the
 * declaration from the amounts the customer actually paid, as stored on the order.
 *
 * be-BOP stores each item's price without VAT, and the VAT per rate for the whole order,
 * delivery included, rounded once. That VAT is split between the lines and the delivery to the
 * cent, and the result must add up exactly to the total paid: otherwise the order needs review,
 * so that nothing is ever rounded silently.
 */
export function buildEasDeclaration(order: Order, ctx: EasDeclarationContext): EasDecision {
	const review = (reason: string): EasDecision => ({ kind: 'needs_review', reason });

	const address = order.shippingAddress;
	if (!address || !isEuCountry(address.country)) {
		return { kind: 'skipped', reason: 'delivery outside the EU' };
	}
	if (hasB2bMark(address) || hasB2bMark(order.billingAddress)) {
		return { kind: 'skipped', reason: 'B2B order (company or VAT number given)' };
	}
	if (order.status !== 'paid') {
		return review('order is not paid');
	}

	const email = (order.notifications?.paymentStatus?.email || order.user?.email || '').trim();
	if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
		return review('no customer e-mail address, which EAS requires');
	}
	if (!ctx.sellerCountry) {
		return review("the shop's country is not set in its seller identity");
	}

	const main = order.currencySnapshot.main;
	const currency = main.totalPrice.currency;
	if (currency === 'BTC' || currency === 'SAT') {
		return review(`order amounts are in ${currency}, not in a fiat currency`);
	}
	const scale = 10 ** FRACTION_DIGITS_PER_CURRENCY[currency];
	const toMinor = (amount: number) => amount * scale;

	if (order.discount) {
		return review('order-level discount');
	}
	if (order.vatFree) {
		return review('the order was charged no VAT (VAT exemption)');
	}
	if (!order.items.length) {
		return review('order has no items');
	}
	for (const item of order.items) {
		if (!item.product.shipping) {
			return review('order contains an item that is not shipped');
		}
		if (item.booking) {
			return review('order contains a booking');
		}
		if ((item.depositPercentage ?? 100) < 100) {
			return review('order contains an item paid as a deposit');
		}
		if (item.freeQuantity) {
			return review('order contains free units');
		}
		if (
			item.currencySnapshot.main.price.currency !== currency ||
			(item.currencySnapshot.main.customPrice &&
				item.currencySnapshot.main.customPrice.currency !== currency)
		) {
			return review('item prices are not in the order currency');
		}
	}

	const vat = order.vat ?? [];
	const vatAmounts = main.vat ?? [];
	if (!vat.length || !vatAmounts.length) {
		return review('the order was charged no VAT');
	}
	if (vat.length > 1 || vatAmounts.length > 1) {
		return review('the order has several VAT rates');
	}
	if (vat[0].country !== address.country) {
		return review('VAT was charged for another country than the delivery country');
	}
	const rate = vat[0].rate;
	if (!(rate > 0)) {
		return review('the order was charged no VAT');
	}
	if (order.items.some((item) => item.vatRate !== rate)) {
		return review('the items have different VAT rates');
	}
	if (vatAmounts[0].currency !== currency) {
		return review('VAT is not in the order currency');
	}
	if (main.shippingPrice && main.shippingPrice.currency !== currency) {
		return review('delivery price is not in the order currency');
	}

	const lines = order.items.map((item) => {
		const unitCost = orderIndividualItemPrice(item, 'main');
		return { item, unitCost, lineHt: unitCost * item.quantity };
	});
	const itemsHt = lines.reduce((sum, line) => sum + line.lineHt, 0);
	// Stored without VAT (be-BOP's delivery fee is not VAT-included on this shop, checked below)
	const deliveryHt = main.shippingPrice?.amount ?? 0;
	const vatTotalMinor = Math.round(toMinor(vatAmounts[0].amount));
	const totalMinor = Math.round(toMinor(main.totalPrice.amount));

	// The VAT stored must be the one of these amounts, and they must add up to the total paid.
	const vatExactMinor = toMinor(((itemsHt + deliveryHt) * rate) / 100);
	if (Math.abs(vatExactMinor - vatTotalMinor) > 0.5 + EPSILON) {
		return review('stored VAT does not match the items and delivery prices');
	}
	const paidMinor = toMinor(itemsHt + deliveryHt) + vatTotalMinor;
	if (Math.abs(paidMinor - totalMinor) > EPSILON) {
		return review('items, delivery and VAT do not add up exactly to the total paid');
	}

	const allocation = allocateMinorUnits(
		[
			...lines.map((line) => toMinor((line.lineHt * rate) / 100)),
			toMinor((deliveryHt * rate) / 100)
		],
		vatTotalMinor
	);
	if (!allocation) {
		return review('VAT cannot be split between the lines to the cent');
	}
	const deliveryVatMinor = allocation[allocation.length - 1];

	const intrinsicValueEur = ctx.toEur(itemsHt, currency);
	if (intrinsicValueEur === undefined) {
		return review(`no exchange rate from ${currency} to EUR`);
	}
	if (intrinsicValueEur > IOSS_THRESHOLD_EUR) {
		return review(
			`intrinsic value above ${IOSS_THRESHOLD_EUR} EUR: VAT was charged but IOSS does not apply`
		);
	}

	const paidAt = order.payments
		.filter((payment) => payment.status === 'paid' && payment.paidAt)
		.map((payment) => payment.paidAt as Date)
		.sort((a, b) => b.getTime() - a.getTime())[0];
	if (!paidAt) {
		return review('no payment date');
	}

	const usedIds = new Map<string, number>();
	const uniqueId = (productId: string) => {
		const seen = (usedIds.get(productId) ?? 0) + 1;
		usedIds.set(productId, seen);
		return seen === 1 ? productId : `${productId}#${seen}`;
	};

	const [line1, ...rest] = address.address
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	const externalOrderId = String(order.number);
	const entry: EasOrderEntry = {
		order: {
			recipient_title: '',
			recipient_first_name: address.firstName,
			recipient_last_name: address.lastName,
			recipient_company_name: '',
			recipient_company_vat: '',
			is_delivery_to_person: true,
			delivery_address_line_1: line1 ?? '',
			delivery_address_line_2: rest.join(', '),
			delivery_city: address.city,
			delivery_state_province: address.state ?? '',
			delivery_postal_code: address.zip,
			delivery_country: address.country,
			delivery_email: email,
			delivery_phone: address.phone ?? '',
			delivery_method: 'postal',
			delivery_cost: (Math.round(toMinor(deliveryHt)) + deliveryVatMinor) / scale,
			payment_currency: currency,
			external_order_id: externalOrderId,
			total_order_amount: totalMinor / scale,
			order_breakdown: lines.map((line, i) => ({
				id_provided_by_em: uniqueId(line.item.product._id),
				short_description: line.item.product.name.slice(0, 255),
				long_description: '',
				quantity: line.item.quantity,
				unit_cost: line.unitCost,
				vat_rate: rate,
				item_vat: allocation[i] / scale,
				// The whole delivery goes on the first line, as EAS suggests when the shop does not
				// prorate it: same VAT rate for all lines, so nothing to prorate.
				item_delivery_charge: i === 0 ? deliveryHt : 0,
				item_delivery_charge_vat: i === 0 ? deliveryVatMinor / scale : 0,
				weight: EAS_GOODS.weightKgPerUnit,
				hs6p_received: EAS_GOODS.hs6,
				type_of_goods: 'goods',
				originating_country: EAS_GOODS.originatingCountry,
				location_warehouse_country: EAS_GOODS.warehouseCountry,
				seller_registration_country: ctx.sellerCountry as string,
				reduced_tbe_vat_group: false,
				act_as_disclosed_agent: false
			}))
		},
		// The tracking number is not known when the order is paid: EAS then wants the order number.
		s10_code: externalOrderId,
		sale_date: easSaleDate(paidAt)
	};

	return { kind: 'declare', entry, intrinsicValueEur };
}
