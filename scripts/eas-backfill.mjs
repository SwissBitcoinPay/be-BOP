/**
 * Queues the EAS (IOSS) declaration of orders that were already paid, delivered to the EU,
 * before the declarations were queued automatically (or before the queue existed).
 *
 * Dry run by default: lists the orders it would queue (number, payment date, country) and
 * writes nothing. Add --write to queue them. An order already queued for the environment is
 * left as it is, so running it twice declares nothing twice.
 *
 *   MONGODB_URL=… MONGODB_DB=… node scripts/eas-backfill.mjs [--environment production|test]
 *       [--since 2026-01-01] [--write]
 *
 * The environment defaults to production. The queued orders are sent by the be-BOP worker
 * only if EAS_ENABLED=true and EAS_ENVIRONMENT is that environment.
 */
import mongodb from 'mongodb';
import { pathToFileURL } from 'node:url';

/** Same list as EU_COUNTRIES in src/lib/server/eas/declaration.ts (a test checks it) */
export const EU_COUNTRIES = [
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
];

/**
 * @param {import('mongodb').Db} db
 * @param {{ environment: 'test' | 'production', write: boolean, since?: Date }} opts
 * @returns {Promise<{ toQueue: Array<{ number: number, country: string, paidAt?: Date }>, alreadyQueued: number }>}
 */
export async function easBackfill(db, opts) {
	const orders = await db
		.collection('orders')
		.find(
			{
				status: 'paid',
				'shippingAddress.country': { $in: EU_COUNTRIES },
				...(opts.since && { createdAt: { $gte: opts.since } })
			},
			{ projection: { _id: 1, number: 1, 'shippingAddress.country': 1, payments: 1 } }
		)
		.sort({ number: 1 })
		.toArray();

	const declarations = db.collection('easDeclarations');
	const queued = new Set(
		(
			await declarations
				.find({ environment: opts.environment }, { projection: { externalOrderId: 1 } })
				.toArray()
		).map((d) => d.externalOrderId)
	);

	const toQueue = [];
	let alreadyQueued = 0;
	for (const order of orders) {
		if (queued.has(String(order.number))) {
			alreadyQueued++;
			continue;
		}
		const paidAt = (order.payments ?? [])
			.filter((p) => p.status === 'paid' && p.paidAt)
			.map((p) => p.paidAt)
			.sort((a, b) => b - a)[0];
		toQueue.push({
			_id: order._id,
			number: order.number,
			country: order.shippingAddress.country,
			paidAt
		});
	}

	if (opts.write) {
		const now = new Date();
		for (const order of toQueue) {
			await declarations.updateOne(
				{ environment: opts.environment, externalOrderId: String(order.number) },
				{
					$setOnInsert: {
						_id: new mongodb.ObjectId(),
						environment: opts.environment,
						externalOrderId: String(order.number),
						orderId: order._id,
						status: 'pending',
						source: 'backfill',
						attempts: 0,
						nextAttemptAt: now,
						createdAt: now,
						updatedAt: now
					}
				},
				{ upsert: true }
			);
		}
	}

	return {
		toQueue: toQueue.map(({ number, country, paidAt }) => ({ number, country, paidAt })),
		alreadyQueued
	};
}

function parseArgs(argv) {
	const args = { environment: 'production', write: false, since: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--write') {
			args.write = true;
		} else if (arg === '--environment') {
			args.environment = argv[++i];
		} else if (arg === '--since') {
			args.since = new Date(argv[++i]);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (args.environment !== 'production' && args.environment !== 'test') {
		throw new Error('--environment must be production or test');
	}
	if (args.since && isNaN(args.since.getTime())) {
		throw new Error('--since must be a date, e.g. 2026-01-01');
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { MONGODB_URL, MONGODB_DB } = process.env;
	if (!MONGODB_URL || !MONGODB_DB) {
		throw new Error('MONGODB_URL and MONGODB_DB must be set');
	}
	const client = new mongodb.MongoClient(MONGODB_URL);
	await client.connect();
	try {
		const { toQueue, alreadyQueued } = await easBackfill(client.db(MONGODB_DB), args);
		console.log(
			`${args.write ? 'Queued' : 'Would queue (dry run)'} ${
				toQueue.length
			} paid EU order(s) for EAS ${args.environment}; ${alreadyQueued} already queued.`
		);
		for (const order of toQueue) {
			console.log(
				`  #${order.number}  ${order.country}  paid ${order.paidAt?.toISOString() ?? '?'}`
			);
		}
		if (!args.write && toQueue.length) {
			console.log('Nothing written. Run again with --write to queue them.');
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
