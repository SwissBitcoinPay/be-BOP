import { describe, expect, it } from 'vitest';
import { toCurrency } from './toCurrency';

describe('toCurrency rounding', () => {
	it('rounds half up as the amount is written, despite floating point', () => {
		// 10.455 * 100 === 1045.4999999999998, 1.005 * 100 === 100.49999999999999
		expect(toCurrency('CHF', 10.455, 'CHF')).toBe(10.46);
		expect(toCurrency('CHF', 41 * 0.255, 'CHF')).toBe(10.46);
		expect(toCurrency('EUR', 1.005, 'EUR')).toBe(1.01);
		expect(toCurrency('EUR', 2.675, 'EUR')).toBe(2.68);
	});

	it('leaves amounts below the half alone', () => {
		expect(toCurrency('CHF', 10.454999, 'CHF')).toBe(10.45);
		expect(toCurrency('CHF', 0.1 + 0.2, 'CHF')).toBe(0.3);
		expect(toCurrency('SAT', 1234.4999, 'SAT')).toBe(1234);
	});

	it('keeps all the digits of large amounts', () => {
		expect(toCurrency('BTC', 20_999_999.12345678, 'BTC')).toBe(20_999_999.12345678);
		expect(toCurrency('SAT', 2_099_999_912_345_678, 'SAT')).toBe(2_099_999_912_345_678);
	});
});
