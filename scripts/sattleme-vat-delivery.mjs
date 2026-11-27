/**
 * sattle.me shop settings: the VAT of the delivery country on EU deliveries only, 0 % everywhere
 * else (Switzerland included), and delivery only to the countries listed below.
 *
 * It writes, in this order:
 *   1. a VAT profile "UE seule" with a rate for every country be-BOP knows: the EU standard rate,
 *      0 elsewhere, so that no country falls back to be-BOP's built-in rate table;
 *   2. that profile on every product;
 *   3. the delivery fees: the flat fee for each listed country, no "Other countries" (default)
 *      fee, and the same VAT profile;
 *   4. vatExempted = false, only once 1 to 3 are checked in the database.
 *
 * Dry run by default: prints the current settings and those it would write, and writes nothing.
 *
 *   MONGODB_URL=… MONGODB_DB=… node scripts/sattleme-vat-delivery.mjs [--write]
 *
 * The running be-BOP picks up the settings by itself (change stream on runtimeConfig; VAT
 * profiles and products are read on each request). Running it twice changes nothing more.
 */
import mongodb from 'mongodb';
import { pathToFileURL } from 'node:url';
import { COUNTRY_ALPHA2S } from '../src/lib/types/Country.ts';

export const VAT_PROFILE_NAME = 'UE seule';

/**
 * EU standard VAT rates, from Your Europe, page checked on 2026-07-13:
 * https://europa.eu/youreurope/business/taxation/vat/vat-rules-rates/index_en.htm
 * (Greece is "EL" there and "GR" in be-BOP.)
 */
export const EU_STANDARD_VAT_RATES = {
	AT: 20,
	BE: 21,
	BG: 20,
	CY: 19,
	CZ: 21,
	DE: 19,
	DK: 25,
	EE: 24,
	GR: 24,
	ES: 21,
	FI: 25.5,
	FR: 20,
	HR: 25,
	HU: 27,
	IE: 23,
	IT: 22,
	LT: 21,
	LU: 17,
	LV: 21,
	MT: 18,
	NL: 21,
	PL: 23,
	PT: 23,
	RO: 21,
	SE: 25,
	SI: 22,
	SK: 23
};

/** The EU, then Switzerland, Liechtenstein, the US, Canada, Australia, Norway, Japan, South Korea */
export const DELIVERY_COUNTRIES = [
	...Object.keys(EU_STANDARD_VAT_RATES),
	'CH',
	'LI',
	'US',
	'CA',
	'AU',
	'NO',
	'JP',
	'KR'
];

/** The current flat fee, excluding VAT, until the warehouse's price list */
export const DELIVERY_FEE = { amount: 8, currency: 'CHF' };

/** A rate for every country be-BOP knows */
export function vatProfileRates() {
	return Object.fromEntries(
		[...COUNTRY_ALPHA2S].map((country) => [country, EU_STANDARD_VAT_RATES[country] ?? 0])
	);
}

const VAT_KEYS = ['vatExempted', 'vatSingleCountry', 'vatCountry', 'vatNullOutsideSellerCountry'];

/** The settings this script is about, as stored (undefined = not stored, be-BOP's default) */
export async function readSettings(db) {
	const configs = await db
		.collection('runtimeConfig')
		.find({ _id: { $in: [...VAT_KEYS, 'deliveryFees'] } })
		.toArray();
	const byKey = Object.fromEntries(configs.map((c) => [c._id, c.data]));
	const profile = await db.collection('vatProfiles').findOne({ name: VAT_PROFILE_NAME });
	const products = await db
		.collection('products')
		.find({}, { projection: { _id: 1, vatProfileId: 1 } })
		.sort({ _id: 1 })
		.toArray();
	return {
		vat: Object.fromEntries(VAT_KEYS.map((key) => [key, byKey[key]])),
		deliveryFees: byKey.deliveryFees,
		vatProfiles: await db.collection('vatProfiles').countDocuments(),
		profile: profile && { _id: profile._id, name: profile.name, rates: profile.rates },
		products: products.map((p) => ({ _id: p._id, vatProfileId: p.vatProfileId }))
	};
}

/** The delivery fees to write, keeping the settings this script does not change */
export function targetDeliveryFees(current, profileId) {
	return {
		...current,
		mode: 'flatFee',
		applyFlatFeeToEachItem: false,
		vatIncludedReference: false,
		deliveryFees: Object.fromEntries(
			DELIVERY_COUNTRIES.map((country) => [country, { ...DELIVERY_FEE }])
		),
		vatProfileId: profileId
	};
}

/**
 * What be-BOP needs so that no product nor the delivery fee uses its built-in rate table.
 * Returns the problems found (empty = ready to charge VAT).
 */
export async function checkNoFallback(db) {
	const problems = [];
	const profile = await db.collection('vatProfiles').findOne({ name: VAT_PROFILE_NAME });
	if (!profile) {
		return [`no VAT profile "${VAT_PROFILE_NAME}"`];
	}
	const missing = [...COUNTRY_ALPHA2S].filter((c) => typeof profile.rates?.[c] !== 'number');
	if (missing.length) {
		problems.push(`the VAT profile has no rate for ${missing.join(', ')}`);
	}
	const wrong = Object.entries(vatProfileRates()).filter(([c, r]) => profile.rates?.[c] !== r);
	if (wrong.length) {
		problems.push(`the VAT profile has other rates for ${wrong.map(([c]) => c).join(', ')}`);
	}
	const withoutProfile = await db
		.collection('products')
		.find({ vatProfileId: { $ne: profile._id } }, { projection: { _id: 1 } })
		.toArray();
	if (withoutProfile.length) {
		problems.push(`products without the profile: ${withoutProfile.map((p) => p._id).join(', ')}`);
	}
	const delivery = await db.collection('runtimeConfig').findOne({ _id: 'deliveryFees' });
	if (delivery?.data?.vatProfileId !== profile._id.toString()) {
		problems.push('the delivery fees do not use the profile');
	}
	const fees = Object.keys(delivery?.data?.deliveryFees ?? {});
	if (
		delivery?.data?.mode !== 'flatFee' ||
		delivery.data.applyFlatFeeToEachItem ||
		fees.includes('default') ||
		fees.length !== DELIVERY_COUNTRIES.length ||
		!DELIVERY_COUNTRIES.every((c) => fees.includes(c))
	) {
		problems.push('the delivery fees are not the flat fee for the listed countries only');
	}
	return problems;
}

/**
 * @param {import('mongodb').Db} db
 * @param {{ write: boolean, now?: Date }} opts
 */
export async function applySettings(db, opts) {
	const before = await readSettings(db);
	const profileId = before.profile?._id ?? new mongodb.ObjectId();
	const after = {
		vat: { ...before.vat, vatExempted: false },
		deliveryFees: targetDeliveryFees(before.deliveryFees ?? {}, profileId.toString()),
		profile: { _id: profileId, name: VAT_PROFILE_NAME, rates: vatProfileRates() },
		products: before.products.map((p) => ({ _id: p._id, vatProfileId: profileId }))
	};

	if (!opts.write) {
		return { before, after, written: false };
	}

	const now = opts.now ?? new Date();
	await db.collection('vatProfiles').updateOne(
		{ _id: profileId },
		{
			$set: { name: VAT_PROFILE_NAME, rates: after.profile.rates, updatedAt: now },
			$setOnInsert: { createdAt: now }
		},
		{ upsert: true }
	);
	await db
		.collection('products')
		.updateMany(
			{ vatProfileId: { $ne: profileId } },
			{ $set: { vatProfileId: profileId, updatedAt: now } }
		);
	await db
		.collection('runtimeConfig')
		.updateOne(
			{ _id: 'deliveryFees' },
			{ $set: { data: after.deliveryFees, updatedAt: now } },
			{ upsert: true }
		);

	const problems = await checkNoFallback(db);
	if (problems.length) {
		throw new Error(`VAT exemption left on: ${problems.join('; ')}`);
	}
	if (before.vat.vatExempted !== false) {
		await db
			.collection('runtimeConfig')
			.updateOne(
				{ _id: 'vatExempted' },
				{ $set: { data: false, updatedAt: now } },
				{ upsert: true }
			);
	}
	return { before, after: await readSettings(db), written: true };
}

function summarize(settings) {
	const lines = [];
	for (const [key, value] of Object.entries(settings.vat)) {
		lines.push(`  ${key}: ${value === undefined ? '(not set, default)' : JSON.stringify(value)}`);
	}
	const { deliveryFees: fees, ...delivery } = settings.deliveryFees ?? {};
	lines.push(`  deliveryFees: ${JSON.stringify(delivery)}`);
	const byFee = {};
	for (const [country, fee] of Object.entries(fees ?? {})) {
		(byFee[`${fee.amount} ${fee.currency}`] ??= []).push(
			country === 'default' ? 'Other countries' : country
		);
	}
	for (const [fee, countries] of Object.entries(byFee)) {
		lines.push(`    ${fee} (${countries.length}): ${countries.join(' ')}`);
	}
	if (settings.profile) {
		const rates = Object.entries(settings.profile.rates);
		const nonZero = rates.filter(([, r]) => r !== 0).map(([c, r]) => `${c} ${r}`);
		lines.push(
			`  VAT profile "${settings.profile.name}" ${settings.profile._id}: ${rates.length} countries, ` +
				`${nonZero.length} not at 0: ${nonZero.join(', ')}`
		);
	} else {
		lines.push(`  VAT profile "${VAT_PROFILE_NAME}": none`);
	}
	const assigned = settings.products.filter(
		(p) => settings.profile && p.vatProfileId?.toString() === settings.profile._id.toString()
	).length;
	lines.push(`  products: ${settings.products.length}, ${assigned} with the profile`);
	return lines.join('\n');
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some((a) => a !== '--write')) {
		throw new Error('Usage: node scripts/sattleme-vat-delivery.mjs [--write]');
	}
	const write = args.includes('--write');
	const { MONGODB_URL, MONGODB_DB } = process.env;
	if (!MONGODB_URL || !MONGODB_DB) {
		throw new Error('MONGODB_URL and MONGODB_DB must be set');
	}
	const client = new mongodb.MongoClient(MONGODB_URL);
	await client.connect();
	try {
		const { before, after, written } = await applySettings(client.db(MONGODB_DB), { write });
		console.log(`Current settings:\n${summarize(before)}\n`);
		console.log(`${written ? 'Written' : 'Would write (dry run)'}:\n${summarize(after)}`);
		if (!written) {
			console.log('\nNothing written. Run again with --write to apply.');
		}
	} finally {
		await client.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}
