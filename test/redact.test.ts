import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredSecrets,
  maskSecret,
  redact,
  redactString,
  redactUrl,
  registerSecret,
} from '../src/core/redact.js';

/**
 * These are the highest-value tests in the suite.
 *
 * A leaked access token gives an attacker full control of a real trading
 * account until 6 AM the next morning. The two paths that carry it — the
 * Authorization header and the WebSocket URL — are exercised explicitly.
 */

const API_KEY = 'abcd1234efgh';
const ACCESS_TOKEN = 'SUPERSECRETTOKEN0123456789';
const API_SECRET = 'topsecretapisecretvalue999';

beforeEach(() => {
  clearRegisteredSecrets();
});

describe('the Authorization header', () => {
  it('is never printed, in any casing', () => {
    for (const header of ['Authorization', 'authorization', 'AUTHORIZATION']) {
      const line = `${header}: token ${API_KEY}:${ACCESS_TOKEN}`;
      expect(redactString(line)).not.toContain(ACCESS_TOKEN);
    }
  });

  it('is redacted inside a serialised headers object', () => {
    const redacted = redact({
      headers: {
        Authorization: `token ${API_KEY}:${ACCESS_TOKEN}`,
        'X-Kite-Version': '3',
      },
    });
    expect(JSON.stringify(redacted)).not.toContain(ACCESS_TOKEN);
    // Non-secret headers survive, or debugging becomes impossible.
    expect(JSON.stringify(redacted)).toContain('X-Kite-Version');
  });

  it('is redacted from a real Headers instance', () => {
    const headers = new Headers({
      Authorization: `token ${API_KEY}:${ACCESS_TOKEN}`,
    });
    expect(JSON.stringify(redact(headers))).not.toContain(ACCESS_TOKEN);
  });
});

describe('the WebSocket URL', () => {
  const wsUrl = `wss://ws.kite.trade/?api_key=${API_KEY}&access_token=${ACCESS_TOKEN}`;

  it('has its access_token stripped but keeps the api_key', () => {
    const redacted = redactUrl(wsUrl);
    expect(redacted).not.toContain(ACCESS_TOKEN);
    // api_key is semi-public and useful when debugging which app is connecting.
    expect(redacted).toContain(API_KEY);
  });

  it('is redacted when embedded in an error message', () => {
    const error = new Error(`connect ECONNREFUSED ${wsUrl}`);
    expect(JSON.stringify(redact(error))).not.toContain(ACCESS_TOKEN);
  });

  it('does not throw on an unparseable URL', () => {
    expect(() => redactUrl('not a url at all')).not.toThrow();
  });
});

describe('secret-bearing fields', () => {
  it('redacts query and form parameters', () => {
    const body = `api_key=${API_KEY}&request_token=REQ123456&checksum=deadbeefcafe`;
    const redacted = redactString(body);
    expect(redacted).not.toContain('REQ123456');
    expect(redacted).not.toContain('deadbeefcafe');
  });

  it('redacts JSON fields', () => {
    const json = JSON.stringify({
      access_token: ACCESS_TOKEN,
      user_id: 'AB1234',
    });
    const redacted = redactString(json);
    expect(redacted).not.toContain(ACCESS_TOKEN);
    expect(redacted).toContain('AB1234');
  });

  it('redacts every documented secret key by name', () => {
    const payload = {
      api_secret: API_SECRET,
      access_token: ACCESS_TOKEN,
      refresh_token: 'refresh123456',
      public_token: 'public123456',
      enctoken: 'enc123456789',
      request_token: 'req123456789',
      checksum: 'sum123456789',
      user_id: 'AB1234',
    };
    const serialised = JSON.stringify(redact(payload));
    for (const secret of Object.values(payload).filter((v) => v !== 'AB1234')) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).toContain('AB1234');
  });
});

describe('registered secrets', () => {
  it('are scrubbed even where no pattern matches', () => {
    registerSecret(ACCESS_TOKEN);
    // A message shaped like nothing we anticipate.
    const weird = `the OMS said <<${ACCESS_TOKEN}>> which is unexpected`;
    expect(redactString(weird)).not.toContain(ACCESS_TOKEN);
  });

  it('ignores values too short to be credentials', () => {
    registerSecret('abc');
    // Scrubbing a 3-char string would mangle unrelated output.
    expect(redactString('abc def')).toBe('abc def');
  });

  it('scrubs nested inside arrays and objects', () => {
    registerSecret(ACCESS_TOKEN);
    const nested = { a: [{ b: { c: `prefix-${ACCESS_TOKEN}-suffix` } }] };
    expect(JSON.stringify(redact(nested))).not.toContain(ACCESS_TOKEN);
  });
});

describe('non-plain objects survive the walk', () => {
  /**
   * Object.entries(new Date()) is [], so a generic recursive walk flattens
   * every Date to {}. Tick timestamps flow straight into `kite watch --json`,
   * so this silently destroys the data scripts consume.
   */
  it('serialises Dates to ISO strings rather than {}', () => {
    const out = redact({
      lastTradeTime: new Date('2026-07-20T10:00:00Z'),
      price: 1500,
    }) as Record<string, unknown>;
    expect(out['lastTradeTime']).toBe('2026-07-20T10:00:00.000Z');
    expect(out['price']).toBe(1500);
  });

  it('handles an invalid Date without emitting garbage', () => {
    const out = redact({ t: new Date('nonsense') }) as Record<string, unknown>;
    expect(out['t']).toBeNull();
  });

  it('preserves nested Dates inside arrays', () => {
    const out = redact([{ t: new Date('2026-07-20T10:00:00Z') }]) as Array<Record<string, unknown>>;
    expect(out[0]!['t']).toBe('2026-07-20T10:00:00.000Z');
  });

  it('renders Maps and Sets instead of collapsing them', () => {
    expect(redact({ m: new Map([['a', 1]]) })).toEqual({ m: { a: 1 } });
    expect(redact({ s: new Set([1, 2]) })).toEqual({ s: [1, 2] });
  });

  it('summarises Buffers rather than dumping every byte index', () => {
    expect(redact({ b: Buffer.alloc(184) })).toEqual({
      b: '[buffer 184 bytes]',
    });
  });
});

describe('robustness', () => {
  it('handles circular references without hanging', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular['self'] = circular;
    expect(() => redact(circular)).not.toThrow();
    expect(JSON.stringify(redact(circular))).toContain('[circular]');
  });

  it('preserves non-secret values', () => {
    const input = {
      quantity: 10,
      symbol: 'INFY',
      price: 1500.5,
      nested: { ok: true },
    };
    expect(redact(input)).toEqual(input);
  });

  it('masks secrets for display without revealing them', () => {
    const masked = maskSecret(ACCESS_TOKEN);
    expect(masked).not.toContain(ACCESS_TOKEN);
    // Enough to identify which credential it is.
    expect(masked.endsWith(ACCESS_TOKEN.slice(-4))).toBe(true);
  });
});
