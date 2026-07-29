import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KiteApi } from '../src/core/api.js';
import { MfInstrumentStore, parseMfInstrumentsCsv } from '../src/core/mfInstruments.js';
import { cacheDir } from '../src/core/paths.js';

/**
 * MfInstrumentStore parsing, keying and search — same shape as
 * instruments-store.test.ts, but the MF dump has no exchange to key on: Kite's
 * MF `tradingsymbol` is the scheme's ISIN, so lookup and search key on ISIN
 * and fund name instead.
 */

const CSV = [
  'tradingsymbol,amc,name,purchase_allowed,redemption_allowed,minimum_purchase_amount,purchase_amount_multiplier,minimum_additional_purchase_amount,minimum_redemption_quantity,redemption_quantity_multiplier,dividend_type,scheme_type,plan,settlement_type,last_price,last_price_date',
  'INF879O01027,ParagParikhMutualFund_MF,Parag Parikh Flexi Cap Fund,1,1,1000.0,1.0,500.0,0.001,0.001,growth,equity,direct,T3,75.5,2026-07-20',
  'INF879O01019,ParagParikhMutualFund_MF,Parag Parikh Flexi Cap Fund,1,1,1000.0,1.0,500.0,0.001,0.001,growth,equity,regular,T3,70.2,2026-07-20',
  'INF209K01157,BirlaSunLifeMutualFund_MF,Aditya Birla Sun Life Advantage Fund,1,0,1000.0,1.0,1000.0,0.001,0.001,payout,equity,regular,T3,106.8,2017-11-23',
  '',
].join('\n');

function fakeApi(csv = CSV): KiteApi {
  return { getMfInstrumentsCsv: async () => csv } as unknown as KiteApi;
}

async function buildStore(csv = CSV): Promise<MfInstrumentStore> {
  const store = new MfInstrumentStore(fakeApi(csv));
  await store.load({ force: true });
  return store;
}

beforeEach(async () => {
  await rm(cacheDir(), { recursive: true, force: true });
});

describe('parseMfInstrumentsCsv', () => {
  it('coerces booleans and numbers per the documented column types', () => {
    const rows = parseMfInstrumentsCsv(CSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      tradingsymbol: 'INF879O01027',
      amc: 'ParagParikhMutualFund_MF',
      purchase_allowed: true,
      redemption_allowed: true,
      minimum_purchase_amount: 1000,
      last_price: 75.5,
      plan: 'direct',
    });
    // redemption_allowed is "0" for the third row.
    expect(rows[2]?.redemption_allowed).toBe(false);
  });

  it('skips truncated trailing rows', () => {
    expect(parseMfInstrumentsCsv(`${CSV}\nincomplete,row`)).toHaveLength(3);
  });
});

describe('lookup', () => {
  it('resolves by ISIN, case-insensitively', async () => {
    const store = await buildStore();
    expect(store.lookup('inf879o01027')?.name).toBe('Parag Parikh Flexi Cap Fund');
  });

  it('exposes the loaded size', async () => {
    const store = await buildStore();
    expect(store.size).toBe(3);
  });
});

describe('search ranking', () => {
  it('ranks an exact name match above a substring match', async () => {
    const store = await buildStore();
    const results = store.search('Parag Parikh Flexi Cap Fund');
    expect(results[0]?.tradingsymbol).toBe('INF879O01027');
  });

  it('matches on a name substring', async () => {
    const store = await buildStore();
    const results = store.search('parikh');
    expect(results.length).toBe(2);
  });

  it('filters by AMC', async () => {
    const store = await buildStore();
    const results = store.search('fund', { amc: 'BirlaSunLifeMutualFund_MF' });
    expect(results).toHaveLength(1);
    expect(results[0]?.tradingsymbol).toBe('INF209K01157');
  });

  it('filters by plan', async () => {
    const store = await buildStore();
    const results = store.search('parikh', { plan: 'direct' });
    expect(results).toHaveLength(1);
    expect(results[0]?.tradingsymbol).toBe('INF879O01027');
  });

  it('honours the result limit', async () => {
    const store = await buildStore();
    expect(store.search('fund', { limit: 1 })).toHaveLength(1);
  });

  it('returns nothing for an empty query', async () => {
    const store = await buildStore();
    expect(store.search('   ')).toEqual([]);
  });
});
