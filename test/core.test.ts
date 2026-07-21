import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { chunks, formatIstDateTime, MAX_DAYS_PER_REQUEST, parseInterval, splitDateRange } from '../src/core/api.js';
import {
  buildLoginUrl,
  computeChecksum,
  computePostbackChecksum,
  safeCompare,
  verifyPostbackChecksum,
} from '../src/core/auth.js';
import { endpointsFor } from '../src/core/config.js';
import { ExitCode } from '../src/core/errors.js';
import { parseCsv, parseInstrumentKey, parseInstrumentsCsv } from '../src/core/instruments.js';
import { configDir, credentialsFile } from '../src/core/paths.js';
import { ORDER_LIMITS, RateLimiter } from '../src/core/ratelimit.js';
import { decryptFromFile, encryptToFile } from '../src/core/secretstore.js';
import { isExpired, nextTokenExpiry } from '../src/core/session.js';
import { parseUserDate } from '../src/output/format.js';

describe('login checksum', () => {
  it('is SHA-256 of api_key + request_token + api_secret concatenated', () => {
    // Verified independently: echo -n "abcdefghtokenxyzsecret123" | shasum -a 256
    const checksum = computeChecksum('abcdefgh', 'tokenxyz', 'secret123');
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(checksum).toBe(createHash('sha256').update('abcdefghtokenxyzsecret123').digest('hex'));
  });
});

describe('postback checksum', () => {
  it('hashes order_id + order_timestamp + api_secret', () => {
    // Documented separately from the login checksum, which takes
    // api_key + request_token + api_secret. Same construction, different
    // inputs — so the guard that matters is that we feed it the right three.
    const orderId = '241120000000001';
    const timestamp = '2026-07-20 10:00:00';
    const secret = 'mysecret';

    expect(computePostbackChecksum(orderId, timestamp, secret)).toBe(
      createHash('sha256').update(`${orderId}${timestamp}${secret}`).digest('hex'),
    );
  });

  it('verifies a valid checksum and rejects a forged one', () => {
    const valid = computePostbackChecksum('241120000000001', '2026-07-20 10:00:00', 'mysecret');
    expect(verifyPostbackChecksum(valid, '241120000000001', '2026-07-20 10:00:00', 'mysecret')).toBe(true);
    expect(verifyPostbackChecksum(valid, '241120000000002', '2026-07-20 10:00:00', 'mysecret')).toBe(false);
    expect(verifyPostbackChecksum('deadbeef', '241120000000001', '2026-07-20 10:00:00', 'mysecret')).toBe(false);
  });
});

describe('constant-time comparison', () => {
  /**
   * timingSafeEqual requires equal BYTE lengths and throws RangeError
   * otherwise. A guard on String.length is not enough: 32 multi-byte
   * characters have the same .length as a 32-char hex state but a different
   * Buffer size. Both call sites compare attacker-controlled input, so a throw
   * here crashes the login callback server.
   */
  it('does not throw on equal string length but different byte length', () => {
    const multiByte = 'é'.repeat(32);
    const ascii = 'a'.repeat(32);
    expect(multiByte.length).toBe(ascii.length);
    expect(() => safeCompare(multiByte, ascii)).not.toThrow();
    expect(safeCompare(multiByte, ascii)).toBe(false);
  });

  it('matches identical strings and rejects different ones', () => {
    expect(safeCompare('abc123', 'abc123')).toBe(true);
    expect(safeCompare('abc123', 'abc124')).toBe(false);
    expect(safeCompare('short', 'longer string')).toBe(false);
  });

  it('does not throw when verifying a postback checksum of the wrong shape', () => {
    expect(() => verifyPostbackChecksum('é'.repeat(64), 'order1', '2026-07-20 10:00:00', 'secret')).not.toThrow();
  });
});

describe('login URL', () => {
  it('includes v=3 and carries CSRF state through redirect_params', () => {
    const url = new URL(
      buildLoginUrl({
        apiKey: 'key123',
        endpoints: endpointsFor('production'),
        state: 'abc123',
      }),
    );
    expect(url.searchParams.get('v')).toBe('3');
    expect(url.searchParams.get('api_key')).toBe('key123');
    expect(url.searchParams.get('redirect_params')).toBe('state=abc123');
  });

  it('points at the sandbox host in sandbox mode', () => {
    const url = buildLoginUrl({
      apiKey: 'sandboxdemo',
      endpoints: endpointsFor('sandbox'),
      state: 'x',
    });
    expect(url).toContain('sandbox.kite.trade');
  });
});

describe('sandbox endpoints', () => {
  it('prefixes routes with /oms, which production does not', () => {
    expect(endpointsFor('sandbox').routePrefix).toBe('/oms');
    expect(endpointsFor('production').routePrefix).toBe('');
  });
});

describe('token expiry', () => {
  it('expires at 6 AM IST the next day when it is already past 6 AM', () => {
    // 2026-07-20 10:00 IST == 04:30 UTC
    const now = new Date('2026-07-20T04:30:00Z');
    const expiry = nextTokenExpiry(now);
    // 6 AM IST on the 21st == 00:30 UTC on the 21st
    expect(expiry.toISOString()).toBe('2026-07-21T00:30:00.000Z');
  });

  it('expires at 6 AM IST today when it is still before 6 AM', () => {
    // 2026-07-20 03:00 IST == 2026-07-19 21:30 UTC
    const now = new Date('2026-07-19T21:30:00Z');
    expect(nextTokenExpiry(now).toISOString()).toBe('2026-07-20T00:30:00.000Z');
  });

  it('treats an unparseable expiry as expired', () => {
    const meta = { expiresAt: 'nonsense' } as never;
    expect(isExpired(meta)).toBe(true);
  });
});

describe('historical range chunking', () => {
  it('returns one range when the span fits in a single request', () => {
    const ranges = splitDateRange(new Date('2026-01-01'), new Date('2026-01-10'), 60);
    expect(ranges).toHaveLength(1);
  });

  it('splits a long minute-interval range at 60 days', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-06-01T00:00:00Z'); // ~151 days
    const ranges = splitDateRange(from, to, MAX_DAYS_PER_REQUEST.minute);

    expect(ranges.length).toBeGreaterThan(2);
    // Ranges must be contiguous and cover the whole span.
    expect(ranges[0]!.from.getTime()).toBe(from.getTime());
    expect(ranges[ranges.length - 1]!.to.getTime()).toBe(to.getTime());
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i]!.from.getTime()).toBeGreaterThan(ranges[i - 1]!.to.getTime());
    }
  });

  it('uses 1900 days for daily candles, matching Zerodha own chunking helper', () => {
    expect(MAX_DAYS_PER_REQUEST.day).toBe(1900);
  });

  it('rejects an inverted range', () => {
    expect(() => splitDateRange(new Date('2026-06-01'), new Date('2026-01-01'), 60)).toThrow();
  });

  it('rejects intervals Kite does not support', () => {
    expect(() => parseInterval('day')).not.toThrow();
    expect(() => parseInterval('5minute')).not.toThrow();
    // These appear in blog posts but are not in the official docs.
    expect(() => parseInterval('2minute')).toThrow();
    expect(() => parseInterval('week')).toThrow();
  });
});

describe('IST date formatting', () => {
  it('formats as Kite expects, in IST not UTC', () => {
    // 2026-07-20T04:30:00Z == 10:00:00 IST
    expect(formatIstDateTime(new Date('2026-07-20T04:30:00Z'))).toBe('2026-07-20 10:00:00');
  });

  it('rolls the date correctly across the IST boundary', () => {
    // 2026-07-19T20:00:00Z == 2026-07-20 01:30 IST
    expect(formatIstDateTime(new Date('2026-07-19T20:00:00Z'))).toBe('2026-07-20 01:30:00');
  });
});

describe('user date parsing', () => {
  const now = new Date('2026-07-20T12:00:00Z');

  it('parses relative offsets', () => {
    expect(parseUserDate('7d', now)!.toISOString().slice(0, 10)).toBe('2026-07-13');
    expect(parseUserDate('1y', now)!.getFullYear()).toBe(2025);
  });

  it('interprets a bare date as IST midnight, not UTC', () => {
    // 2026-07-20 00:00 IST == 2026-07-19T18:30:00Z
    expect(parseUserDate('2026-07-20', now)!.toISOString()).toBe('2026-07-19T18:30:00.000Z');
  });

  it('returns null for gibberish', () => {
    expect(parseUserDate('not a date', now)).toBeNull();
  });
});

describe('CSV parsing', () => {
  it('handles quoted fields containing commas', () => {
    const rows = parseCsv('a,b,c\n1,"hello, world",3\n');
    expect(rows[1]).toEqual(['1', 'hello, world', '3']);
  });

  it('handles escaped quotes', () => {
    const rows = parseCsv('a\n"say ""hi"""\n');
    expect(rows[1]).toEqual(['say "hi"']);
  });

  it('parses an instrument dump', () => {
    const csv = [
      'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
      '408065,1594,INFY,"INFOSYS",1500.5,,0,0.05,1,EQ,NSE,NSE',
      '12345,48,NIFTY24JULFUT,"NIFTY, 50",0,2026-07-31,0,0.05,50,FUT,NFO-FUT,NFO',
      '',
    ].join('\n');

    const instruments = parseInstrumentsCsv(csv);
    expect(instruments).toHaveLength(2);
    expect(instruments[0]).toMatchObject({
      instrument_token: 408065,
      tradingsymbol: 'INFY',
      name: 'INFOSYS',
      exchange: 'NSE',
      lot_size: 1,
    });
    // The comma inside the quoted name must not shift columns.
    expect(instruments[1]!.name).toBe('NIFTY, 50');
    expect(instruments[1]!.lot_size).toBe(50);
  });

  it('skips truncated rows rather than producing garbage', () => {
    const csv = [
      'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
      '408065,1594,INFY',
      '',
    ].join('\n');
    expect(parseInstrumentsCsv(csv)).toHaveLength(0);
  });
});

describe('instrument keys', () => {
  it('parses EXCHANGE:SYMBOL', () => {
    expect(parseInstrumentKey('NFO:NIFTY24JULFUT')).toEqual({
      exchange: 'NFO',
      tradingsymbol: 'NIFTY24JULFUT',
    });
  });

  it('defaults a bare symbol to NSE and upper-cases it', () => {
    expect(parseInstrumentKey('infy')).toEqual({
      exchange: 'NSE',
      tradingsymbol: 'INFY',
    });
  });

  it('rejects a malformed key', () => {
    expect(() => parseInstrumentKey('NSE:')).toThrow();
  });
});

describe('rate limiter', () => {
  it('paces quote calls to roughly 1 per second', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(() => Date.now());
      // The bucket starts full (capacity 1), so the first call is immediate.
      await limiter.acquire('quote');

      let secondResolved = false;
      const second = limiter.acquire('quote').then(() => {
        secondResolved = true;
      });

      await vi.advanceTimersByTimeAsync(500);
      expect(secondResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(600);
      await second;
      expect(secondResolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a burst up to the per-second rate for orders', async () => {
    const limiter = new RateLimiter(() => Date.now());
    const started = Date.now();
    // Order bucket has capacity 10.
    await Promise.all(Array.from({ length: 10 }, () => limiter.acquire('order')));
    expect(Date.now() - started).toBeLessThan(200);
    expect(limiter.orderUsage().minute).toBe(10);
  });

  it('tracks order counts for the documented daily cap', async () => {
    const limiter = new RateLimiter(() => Date.now());
    await limiter.acquire('order');
    await limiter.acquire('order');
    expect(limiter.orderUsage()).toEqual({ minute: 2, day: 2 });
  });

  it('refuses further orders once the per-minute cap is reached, instead of letting Kite 429', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(() => Date.now());
      // Drive the limiter up to Kite's documented per-minute cap, staying inside
      // the 60s window (one token refills every 100ms at 10/sec).
      for (let i = 0; i < ORDER_LIMITS.perMinute; i += 1) {
        const acquired = limiter.acquire('order');
        await vi.advanceTimersByTimeAsync(100);
        await acquired;
      }
      expect(limiter.orderUsage().minute).toBe(ORDER_LIMITS.perMinute);

      // The next order in the same window is refused locally, before any token
      // is consumed, with the rate-limit exit code.
      const error = await limiter.acquire('order').catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/cap/i);
      expect(error.exitCode).toBe(ExitCode.RateLimit);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('chunks', () => {
  it('splits into batches of the requested size', () => {
    expect([...chunks([1, 2, 3, 4, 5], 2)]).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('yields nothing for an empty array', () => {
    expect([...chunks([], 10)]).toEqual([]);
  });
});

describe('encrypted credential file', () => {
  it('round-trips secrets', async () => {
    await mkdir(configDir(), { recursive: true });
    await encryptToFile({ api_secret: 'topsecret', access_token: 'tok123' }, 'correct horse');
    const decrypted = await decryptFromFile('correct horse');
    expect(decrypted).toEqual({
      api_secret: 'topsecret',
      access_token: 'tok123',
    });
  });

  it('rejects the wrong passphrase', async () => {
    await mkdir(configDir(), { recursive: true });
    await encryptToFile({ api_secret: 'topsecret' }, 'right');
    await expect(decryptFromFile('wrong')).rejects.toThrow(/could not decrypt/i);
  });

  it('fails when the header is tampered with', async () => {
    // The header is bound as AES-GCM additional authenticated data specifically
    // so an attacker cannot downgrade the KDF parameters.
    await mkdir(configDir(), { recursive: true });
    await encryptToFile({ api_secret: 'topsecret' }, 'passphrase');

    const path = credentialsFile();
    const raw = await readFile(path, 'utf8');
    const [header, body] = raw.split('\n');
    const weakened = JSON.parse(header!) as { N: number };
    weakened.N = 1024; // downgrade the work factor
    await writeFile(path, `${JSON.stringify(weakened)}\n${body}\n`, 'utf8');

    await expect(decryptFromFile('passphrase')).rejects.toThrow();
  });

  it('writes the file with 0600 permissions', async () => {
    await mkdir(configDir(), { recursive: true });
    await encryptToFile({ api_secret: 'x' }, 'pass');
    const { stat } = await import('node:fs/promises');
    const mode = (await stat(credentialsFile())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns null when no file exists', async () => {
    const { deleteCredentialFile } = await import('../src/core/secretstore.js');
    await deleteCredentialFile();
    expect(await decryptFromFile('anything')).toBeNull();
  });
});
