import { describe, it, expect } from 'vitest';
import { parsePacket, parseBinaryMessage, divisorFor, isTradable } from '../src/core/ticker.js';

/**
 * Binary tick parsing.
 *
 * These packets are fixed-length structs with no self-description, so the only
 * defence against a transposed field is a test that builds a packet by offset
 * and asserts the decoded value.
 */

function u32(view: Buffer, offset: number, value: number): void {
  view.writeUInt32BE(value, offset);
}

/** NSE cash-market token: low byte 1 → divisor 100. */
const NSE_TOKEN = 408065; // 408065 & 0xff === 1
/** NSE currency token: low byte 3 → divisor 10,000,000. */
const NSE_CD_TOKEN = 0x010003;
/** BSE currency token: low byte 6 → divisor 10,000. */
const BSE_CD_TOKEN = 0x010006;
/** Index token: low byte 9 → non-tradeable. */
const INDEX_TOKEN = 256265; // 256265 & 0xff === 9

describe('segment decoding', () => {
  it('derives the divisor from the low byte of the token', () => {
    expect(divisorFor(NSE_TOKEN)).toBe(100);
    expect(divisorFor(NSE_CD_TOKEN)).toBe(10_000_000);
    // BSE currency divides by 10,000 — a case the official docs omit entirely.
    expect(divisorFor(BSE_CD_TOKEN)).toBe(10_000);
  });

  it('identifies indices as non-tradeable', () => {
    expect(isTradable(NSE_TOKEN)).toBe(true);
    expect(isTradable(INDEX_TOKEN)).toBe(false);
  });
});

describe('LTP packets (8 bytes)', () => {
  it('decodes price with the right divisor', () => {
    const buf = Buffer.alloc(8);
    u32(buf, 0, NSE_TOKEN);
    u32(buf, 4, 150050); // paise

    const tick = parsePacket(buf)!;
    expect(tick.mode).toBe('ltp');
    expect(tick.lastPrice).toBe(1500.5);
    expect(tick.instrumentToken).toBe(NSE_TOKEN);
  });

  it('applies the currency divisor', () => {
    const buf = Buffer.alloc(8);
    u32(buf, 0, NSE_CD_TOKEN);
    u32(buf, 4, 875_000_00); // 8.75 at 1e7

    expect(parsePacket(buf)!.lastPrice).toBeCloseTo(8.75, 6);
  });
});

describe('index packets', () => {
  /**
   * Indices order OHLC as high/low/open/close, NOT open/high/low/close like
   * tradeable instruments. This test exists specifically to catch a transposition.
   */
  it('decodes quote mode (28 bytes) with the index field order', () => {
    const buf = Buffer.alloc(28);
    u32(buf, 0, INDEX_TOKEN);
    u32(buf, 4, 2_200_000); // last price 22000.00
    u32(buf, 8, 2_210_000); // HIGH
    u32(buf, 12, 2_190_000); // LOW
    u32(buf, 16, 2_195_000); // OPEN
    u32(buf, 20, 2_180_000); // CLOSE

    const tick = parsePacket(buf)!;
    expect(tick.tradable).toBe(false);
    expect(tick.mode).toBe('quote');
    expect(tick.lastPrice).toBe(22_000);
    expect(tick.ohlc).toEqual({ open: 21_950, high: 22_100, low: 21_900, close: 21_800 });
  });

  it('computes percentage change against the previous close', () => {
    const buf = Buffer.alloc(28);
    u32(buf, 0, INDEX_TOKEN);
    u32(buf, 4, 11_000); // 110.00
    u32(buf, 20, 10_000); // close 100.00

    expect(parsePacket(buf)!.change).toBeCloseTo(10, 6);
  });

  it('reports full mode (32 bytes) with a timestamp', () => {
    const buf = Buffer.alloc(32);
    u32(buf, 0, INDEX_TOKEN);
    u32(buf, 4, 10_000);
    u32(buf, 28, 1_700_000_000);

    const tick = parsePacket(buf)!;
    expect(tick.mode).toBe('full');
    expect(tick.exchangeTimestamp?.getTime()).toBe(1_700_000_000_000);
  });
});

describe('tradeable packets', () => {
  it('decodes quote mode (44 bytes) with the OHLC order', () => {
    const buf = Buffer.alloc(44);
    u32(buf, 0, NSE_TOKEN);
    u32(buf, 4, 150_000); // last price 1500.00
    u32(buf, 8, 25); // last quantity
    u32(buf, 12, 149_500); // average price
    u32(buf, 16, 1_000_000); // volume
    u32(buf, 20, 500); // total buy qty
    u32(buf, 24, 700); // total sell qty
    u32(buf, 28, 148_000); // OPEN
    u32(buf, 32, 152_000); // HIGH
    u32(buf, 36, 147_000); // LOW
    u32(buf, 40, 147_500); // CLOSE

    const tick = parsePacket(buf)!;
    expect(tick.mode).toBe('quote');
    expect(tick.tradable).toBe(true);
    expect(tick.lastPrice).toBe(1500);
    expect(tick.lastQuantity).toBe(25);
    expect(tick.averagePrice).toBe(1495);
    expect(tick.volume).toBe(1_000_000);
    expect(tick.buyQuantity).toBe(500);
    expect(tick.sellQuantity).toBe(700);
    expect(tick.ohlc).toEqual({ open: 1480, high: 1520, low: 1470, close: 1475 });
    expect(tick.depth).toBeUndefined();
  });

  it('decodes full mode (184 bytes) including OI and market depth', () => {
    const buf = Buffer.alloc(184);
    u32(buf, 0, NSE_TOKEN);
    u32(buf, 4, 150_000);
    u32(buf, 40, 147_500); // close
    u32(buf, 44, 1_700_000_500); // last trade time
    u32(buf, 48, 12_345); // oi
    u32(buf, 52, 20_000); // oi day high
    u32(buf, 56, 10_000); // oi day low
    u32(buf, 60, 1_700_000_600); // exchange timestamp

    // First bid: quantity 100, price 1499.00, 3 orders.
    u32(buf, 64, 100);
    u32(buf, 68, 149_900);
    buf.writeUInt16BE(3, 72);

    // First ask (6th entry, offset 64 + 5*12 = 124): qty 200, price 1501.00.
    u32(buf, 124, 200);
    u32(buf, 128, 150_100);
    buf.writeUInt16BE(4, 132);

    const tick = parsePacket(buf)!;
    expect(tick.mode).toBe('full');
    expect(tick.oi).toBe(12_345);
    expect(tick.oiDayHigh).toBe(20_000);
    expect(tick.oiDayLow).toBe(10_000);
    expect(tick.lastTradeTime?.getTime()).toBe(1_700_000_500_000);
    expect(tick.exchangeTimestamp?.getTime()).toBe(1_700_000_600_000);

    expect(tick.depth?.buy).toHaveLength(5);
    expect(tick.depth?.sell).toHaveLength(5);
    expect(tick.depth?.buy[0]).toEqual({ quantity: 100, price: 1499, orders: 3 });
    expect(tick.depth?.sell[0]).toEqual({ quantity: 200, price: 1501, orders: 4 });
  });

  it('leaves timestamps undefined when the exchange sends zero', () => {
    const buf = Buffer.alloc(184);
    u32(buf, 0, NSE_TOKEN);
    expect(parsePacket(buf)!.lastTradeTime).toBeUndefined();
  });
});

describe('message framing', () => {
  function frame(packets: Buffer[]): Buffer {
    const header = Buffer.alloc(2);
    header.writeInt16BE(packets.length, 0);
    // Annotated: inferring from [header] narrows to Buffer<ArrayBuffer>, which
    // then rejects the generic Buffer parameters pushed below.
    const parts: Buffer[] = [header];
    for (const packet of packets) {
      const length = Buffer.alloc(2);
      length.writeInt16BE(packet.length, 0);
      parts.push(length, packet);
    }
    return Buffer.concat(parts);
  }

  function ltpPacket(token: number, paise: number): Buffer {
    const buf = Buffer.alloc(8);
    u32(buf, 0, token);
    u32(buf, 4, paise);
    return buf;
  }

  it('splits multiple packets from one message', () => {
    const message = frame([ltpPacket(NSE_TOKEN, 100_00), ltpPacket(INDEX_TOKEN, 200_00)]);
    const ticks = parseBinaryMessage(message);

    expect(ticks).toHaveLength(2);
    expect(ticks[0]!.lastPrice).toBe(100);
    expect(ticks[1]!.lastPrice).toBe(200);
  });

  it('treats a 1-byte heartbeat as no ticks', () => {
    expect(parseBinaryMessage(Buffer.from([0]))).toEqual([]);
  });

  it('does not throw on a truncated frame', () => {
    // Claims two packets but the buffer ends mid-way through the first.
    const message = frame([ltpPacket(NSE_TOKEN, 100_00)]);
    message.writeInt16BE(2, 0);
    expect(() => parseBinaryMessage(message)).not.toThrow();
    expect(parseBinaryMessage(message)).toHaveLength(1);
  });

  it('does not throw on a bogus length prefix', () => {
    const message = Buffer.alloc(10);
    message.writeInt16BE(1, 0);
    message.writeInt16BE(30_000, 2); // longer than the buffer
    expect(() => parseBinaryMessage(message)).not.toThrow();
    expect(parseBinaryMessage(message)).toEqual([]);
  });

  it('skips packets of an unrecognised size without dropping valid ones', () => {
    const weird = Buffer.alloc(17);
    u32(weird, 0, NSE_TOKEN);
    const ticks = parseBinaryMessage(frame([weird, ltpPacket(NSE_TOKEN, 50_00)]));

    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.lastPrice).toBe(50);
  });

  it('returns nothing for an empty buffer', () => {
    expect(parseBinaryMessage(Buffer.alloc(0))).toEqual([]);
  });
});
