import { describe, expect, it } from 'vitest';
import {
  compactNumber,
  compactRupees,
  dateOnly,
  dateTime,
  money,
  parseUserDate,
  percent,
  quantity,
  rupees,
  signedRupees,
  timeOnly,
  truncate,
} from '../src/output/format.js';

/**
 * Number, currency and date formatting.
 *
 * All pure, and deterministic because the suite pins TZ=Asia/Kolkata. Date
 * assertions use `toContain` on the meaningful parts rather than exact strings,
 * so they survive ICU locale-pattern churn (en-IN reorders day/month across
 * versions); rupee grouping and en-CA dates are stable enough to assert whole.
 */

describe('rupee amounts use Indian digit grouping', () => {
  it('formats lakhs and crores with the en-IN grouping', () => {
    expect(money(1234567.89)).toBe('12,34,567.89');
    expect(rupees(1234567.89)).toBe('₹12,34,567.89');
  });

  it('signs a value, and leaves zero unsigned', () => {
    expect(signedRupees(1200)).toBe('+₹1,200.00');
    expect(signedRupees(-340.5)).toBe('-₹340.50');
    expect(signedRupees(0)).toBe('₹0.00');
  });

  it('abbreviates large amounts as L and Cr at the Indian thresholds', () => {
    expect(compactRupees(15_000_000)).toBe('₹1.50Cr');
    expect(compactRupees(150_000)).toBe('₹1.50L');
    expect(compactRupees(5000)).toBe('₹5,000');
    expect(compactRupees(-2_500_000)).toBe('-₹25.00L');
  });

  it('renders a non-finite or missing amount as an em dash', () => {
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(money(bad)).toBe('—');
      expect(rupees(bad)).toBe('—');
      expect(compactRupees(bad)).toBe('—');
    }
  });
});

describe('percentages, quantities and compact numbers', () => {
  it('signs positive percentages and honours the digit count', () => {
    expect(percent(1.5)).toBe('+1.50%');
    expect(percent(-2)).toBe('-2.00%');
    expect(percent(0)).toBe('0.00%');
    expect(percent(1.234, 1)).toBe('+1.2%');
  });

  it('groups whole quantities', () => {
    expect(quantity(1000)).toBe('1,000');
    expect(quantity(undefined)).toBe('—');
  });

  it('abbreviates volume as K/M/B', () => {
    expect(compactNumber(1500)).toBe('1.5K');
    expect(compactNumber(2_000_000)).toBe('2.0M');
    expect(compactNumber(3_000_000_000)).toBe('3.0B');
    expect(compactNumber(500)).toBe('500');
    expect(compactNumber(-1500)).toBe('-1.5K');
  });
});

describe('dates render in IST', () => {
  it('formats a UTC instant as its IST wall-clock time', () => {
    // 2026-07-20T04:30:00Z == 10:00:00 IST
    const out = dateTime(new Date('2026-07-20T04:30:00Z'));
    expect(out).toContain('2026');
    expect(out).toContain('Jul');
    expect(out).toContain('10:00:00');
  });

  it('treats an unzoned Kite timestamp as IST, not UTC', () => {
    // "YYYY-MM-DD HH:MM:SS" is Kite's implicit-IST shape; it must not be read as UTC.
    expect(dateTime('2026-07-20 10:00:00')).toContain('10:00:00');
    expect(timeOnly('2026-07-20 10:00:00')).toContain('10:00:00');
  });

  it('rolls the calendar date at the IST boundary for date-only output', () => {
    // 2026-07-19T20:00:00Z == 2026-07-20 01:30 IST
    expect(dateOnly(new Date('2026-07-19T20:00:00Z'))).toBe('2026-07-20');
  });

  it('returns an em dash for missing or unparseable input', () => {
    expect(dateTime(undefined)).toBe('—');
    expect(dateTime('not a date')).toBe('—');
    expect(dateOnly(new Date('invalid'))).toBe('—');
  });
});

describe('parseUserDate', () => {
  const now = new Date('2026-07-20T12:00:00Z');

  it('resolves "today" to now', () => {
    expect(parseUserDate('today', now)).toEqual(now);
  });

  it('subtracts relative offsets by unit', () => {
    expect(parseUserDate('2w', now)!.toISOString().slice(0, 10)).toBe('2026-07-06');
    expect(parseUserDate('3m', now)!.getUTCMonth()).toBe(3); // April (0-based)
    expect(parseUserDate('1y', now)!.getUTCFullYear()).toBe(2025);
  });

  it('accepts a date-time without seconds, interpreted as IST', () => {
    // 2026-07-20 10:30 IST == 2026-07-20T05:00:00Z
    expect(parseUserDate('2026-07-20 10:30', now)!.toISOString()).toBe('2026-07-20T05:00:00.000Z');
  });

  it('returns null for gibberish', () => {
    expect(parseUserDate('when the cows come home', now)).toBeNull();
  });
});

describe('truncate', () => {
  it('leaves short strings intact and ellipsises long ones', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello world', 5)).toBe('hell…');
  });

  it('degrades gracefully at tiny widths', () => {
    expect(truncate('xy', 1)).toBe('x');
    expect(truncate('abc', 0)).toBe('');
  });
});
