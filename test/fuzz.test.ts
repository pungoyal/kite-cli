import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { formatInstrumentKey, parseCsv, parseInstrumentKey } from '../src/core/instruments.js';
import { clearRegisteredSecrets, REDACTED, redactString, registerSecret } from '../src/core/redact.js';
import { parseBinaryMessage } from '../src/core/ticker.js';

/**
 * Property-based fuzzing of the parsers that take untrusted input.
 *
 * The ticker frame decoder reads raw bytes off a WebSocket, the CSV parser
 * reads a multi-megabyte dump from Kite, and redaction runs on arbitrary error
 * text. Example-based tests cover the known shapes; these cover the shapes
 * nobody thought to write down.
 */

/** Packet sizes the decoder knows: LTP, index quote/full, quote, full. */
const PACKET_SIZES = [8, 28, 32, 44, 184] as const;

describe('ticker frame decoder', () => {
  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2048 }), (bytes) => {
        const ticks = parseBinaryMessage(Buffer.from(bytes));
        expect(Array.isArray(ticks)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('decodes at most one tick per declared packet, with finite prices', () => {
    const packet = fc
      .constantFrom(...PACKET_SIZES)
      .chain((size) => fc.uint8Array({ minLength: size, maxLength: size }));

    fc.assert(
      fc.property(fc.array(packet, { maxLength: 12 }), (packets) => {
        const frame = Buffer.concat([
          Buffer.from([packets.length >> 8, packets.length & 0xff]),
          ...packets.flatMap((p) => [Buffer.from([p.length >> 8, p.length & 0xff]), Buffer.from(p)]),
        ]);
        const ticks = parseBinaryMessage(frame);
        expect(ticks.length).toBeLessThanOrEqual(packets.length);
        for (const tick of ticks) {
          expect(Number.isFinite(tick.lastPrice)).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('CSV parser', () => {
  // Every field quoted, so commas, quotes, CR and LF inside a value must all
  // survive the round trip.
  const quote = (field: string) => `"${field.replaceAll('"', '""')}"`;

  it('round-trips arbitrary quoted rows', () => {
    fc.assert(
      fc.property(fc.array(fc.array(fc.string(), { minLength: 1, maxLength: 6 }), { maxLength: 8 }), (rows) => {
        const text = rows.map((row) => `${row.map(quote).join(',')}\n`).join('');
        expect(parseCsv(text)).toEqual(rows);
      }),
      { numRuns: 1000 },
    );
  });

  it('never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('a', ',', '"', '\n', '\r', ' ') }), (text) => {
        expect(Array.isArray(parseCsv(text))).toBe(true);
      }),
    );
  });
});

describe('secret redaction', () => {
  afterEach(() => clearRegisteredSecrets());

  // A secret that is itself part of the placeholder (e.g. "redacted") would
  // "survive" by construction; that is not a leak.
  const token = fc.stringMatching(/^[A-Za-z0-9]{8,40}$/).filter((s) => !REDACTED.includes(s));
  const noise = fc.string({ maxLength: 40 });

  it('scrubs a secret-bearing query parameter wherever it appears', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('access_token', 'api_secret', 'request_token', 'checksum', 'enctoken'),
        token,
        noise,
        noise,
        (key, secret, before, after) => {
          const out = redactString(`${before} ${key}=${secret}&x=1 ${after}`);
          expect(out).toContain(`${key}=${REDACTED}`);
          expect(out.split(`${key}=`)[1]?.startsWith(secret)).toBe(false);
        },
      ),
    );
  });

  it('never lets a registered secret through, however it is embedded', () => {
    fc.assert(
      fc.property(token, noise, noise, (secret, before, after) => {
        clearRegisteredSecrets();
        registerSecret(secret);
        expect(redactString(`${before}${secret}${after}`)).not.toContain(secret);
      }),
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const once = redactString(text);
        expect(redactString(once)).toBe(once);
      }),
    );
  });
});

describe('instrument keys', () => {
  it('round-trips EXCHANGE:SYMBOL through parse and format', () => {
    const part = fc.stringMatching(/^[A-Za-z0-9&_-]{1,20}$/);
    fc.assert(
      fc.property(part, part, (exchange, symbol) => {
        const parsed = parseInstrumentKey(`${exchange}:${symbol}`);
        expect(formatInstrumentKey(parsed.exchange, parsed.tradingsymbol)).toBe(`${exchange}:${symbol}`.toUpperCase());
      }),
    );
  });
});
