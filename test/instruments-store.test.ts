import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KiteApi } from '../src/core/api.js';
import { formatInstrumentKey, InstrumentStore } from '../src/core/instruments.js';
import { cacheDir } from '../src/core/paths.js';

/**
 * InstrumentStore lookup and search.
 *
 * The store is fed through its real `load()` path from a fake API that returns a
 * fixed CSV, so parsing, hydration, keying and ranking are all exercised end to
 * end without a network call. `force: true` skips the on-disk cache every time,
 * keeping tests independent of each other's writes.
 *
 * The load-bearing invariant under test: instruments are keyed by
 * EXCHANGE:TRADINGSYMBOL, never by the numeric token, which exchanges reuse
 * across expiries.
 */

const CSV = [
  'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
  '408065,1594,INFY,"INFOSYS",1500,,0,0.05,1,EQ,NSE,NSE',
  '2953217,11536,TCS,"TATA CONSULTANCY SERVICES",3800,,0,0.05,1,EQ,NSE,NSE',
  '12345,48,NIFTY24JULFUT,"NIFTY 50",0,2026-07-31,0,0.05,50,FUT,NFO-FUT,NFO',
  '779521,3045,INFY26JUL1500CE,"INFY 26JUL 1500 CE",0,2026-07-31,1500,0.05,50,CE,NFO-OPT,NFO',
  '500325,1922,RELIANCE,"RELIANCE INDUSTRIES",2800,,0,0.05,1,EQ,BSE,BSE',
  '',
].join('\n');

function fakeApi(csv = CSV): KiteApi {
  return { getInstrumentsCsv: async () => csv } as unknown as KiteApi;
}

async function buildStore(csv = CSV): Promise<InstrumentStore> {
  const store = new InstrumentStore(fakeApi(csv));
  await store.load({ force: true });
  return store;
}

beforeEach(async () => {
  await rm(cacheDir(), { recursive: true, force: true });
});

describe('lookup is keyed by exchange and symbol, case-insensitively', () => {
  it('resolves a symbol regardless of case', async () => {
    const store = await buildStore();
    expect(store.lookup('nse', 'infy')?.instrument_token).toBe(408065);
    expect(store.lookupKey('NSE:INFY')?.instrument_token).toBe(408065);
  });

  it('defaults a bare symbol to NSE', async () => {
    const store = await buildStore();
    expect(store.lookupKey('infy')?.exchange).toBe('NSE');
  });

  it('does not resolve a symbol under the wrong exchange', async () => {
    // Same symbol, different exchange must be a distinct key — the guard against
    // token reuse resolving to the wrong contract.
    const store = await buildStore();
    expect(store.lookup('NFO', 'NIFTY24JULFUT')?.instrument_token).toBe(12345);
    expect(store.lookup('NSE', 'NIFTY24JULFUT')).toBeUndefined();
  });

  it('exposes the loaded size and collection', async () => {
    const store = await buildStore();
    expect(store.size).toBe(5);
    expect(store.all).toHaveLength(5);
  });
});

describe('requireToken', () => {
  it('returns the token for a known instrument', async () => {
    const store = await buildStore();
    expect(store.requireToken('NSE:INFY')).toBe(408065);
  });

  it('throws a usage error naming the instrument when unknown', async () => {
    const store = await buildStore();
    expect(() => store.requireToken('NSE:GHOST')).toThrow(/unknown instrument "NSE:GHOST"/i);
  });
});

describe('search ranking', () => {
  it('ranks an exact symbol match above a substring match', async () => {
    const store = await buildStore();
    const results = store.search('INFY');
    // The equity INFY (exact) must outrank the option that merely contains INFY.
    expect(results[0]?.tradingsymbol).toBe('INFY');
  });

  it('matches on the instrument name too', async () => {
    const store = await buildStore();
    expect(store.search('INFOSYS')[0]?.tradingsymbol).toBe('INFY');
  });

  it('filters by exchange', async () => {
    const store = await buildStore();
    const results = store.search('INFY', { exchange: 'NFO' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.exchange === 'NFO')).toBe(true);
  });

  it('filters by instrument type', async () => {
    const store = await buildStore();
    const results = store.search('NIFTY', { type: 'FUT' });
    expect(results.every((r) => r.instrument_type === 'FUT')).toBe(true);
  });

  it('honours the result limit', async () => {
    const store = await buildStore();
    expect(store.search('I', { limit: 1 })).toHaveLength(1);
  });

  it('returns nothing for an empty query', async () => {
    const store = await buildStore();
    expect(store.search('   ')).toEqual([]);
  });
});

describe('formatInstrumentKey', () => {
  it('upper-cases and joins with a colon', () => {
    expect(formatInstrumentKey('nse', 'infy')).toBe('NSE:INFY');
  });
});
