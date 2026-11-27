import { setTimeout } from 'node:timers/promises';
import { building } from '$app/environment';
import { Lock } from '../lock';
import { processClosed } from '../process';
import { runtimeConfig } from '../runtime-config';
import {
	EAS_CLIENT_ID,
	EAS_CLIENT_SECRET,
	EAS_ENABLED,
	EAS_ENVIRONMENT
} from '$lib/server/env-config';
import { toCurrency } from '$lib/utils/toCurrency';
import type { Currency } from '$lib/types/Currency';
import type { EasEnvironment } from '$lib/types/EasDeclaration';
import { createEasClient, EAS_BASE_URLS, type EasClient } from '../eas/client';
import { processDueEasDeclarations } from '../eas/queue';

const lock = new Lock('eas-declarations');

/** "test" unless explicitly set to "production"; anything else disables sending. */
function easEnvironment(): EasEnvironment | null {
	const value = (EAS_ENVIRONMENT || 'test').trim();
	return value === 'test' || value === 'production' ? value : null;
}

function toEur(amount: number, currency: Currency): number | undefined {
	// toCurrency returns the amount unchanged when a rate is missing: check them first
	if (
		currency !== 'EUR' &&
		(!runtimeConfig.exchangeRate[currency] || !runtimeConfig.exchangeRate.EUR)
	) {
		return undefined;
	}
	return toCurrency('EUR', amount, currency);
}

async function easDeclarationsLoop() {
	let client: EasClient | null = null;
	let warned = false;

	while (!processClosed) {
		await setTimeout(30_000);

		if (EAS_ENABLED !== 'true' || !lock.ownsLock) {
			continue;
		}

		const environment = easEnvironment();
		if (!environment || !EAS_CLIENT_ID || !EAS_CLIENT_SECRET) {
			if (!warned) {
				console.error(
					'[eas] EAS_ENABLED is true but EAS_ENVIRONMENT is invalid or EAS_CLIENT_ID / EAS_CLIENT_SECRET are missing: nothing is sent'
				);
				warned = true;
			}
			continue;
		}

		client ??= createEasClient({
			baseUrl: EAS_BASE_URLS[environment],
			clientId: EAS_CLIENT_ID,
			clientSecret: EAS_CLIENT_SECRET
		});

		try {
			await processDueEasDeclarations({
				environment,
				client,
				context: () => ({
					sellerCountry: runtimeConfig.sellerIdentity?.address.country,
					toEur
				})
			});
		} catch (err) {
			console.error('[eas] worker error:', (err as Error).message);
		}
	}
}

if (!building) {
	easDeclarationsLoop().catch((err) => console.error('[eas] worker stopped:', err));
}
