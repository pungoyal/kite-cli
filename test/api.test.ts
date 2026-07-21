import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KiteApi } from '../src/core/api.js';
import { KiteClient, setDispatcher } from '../src/core/client.js';
import { endpointsFor } from '../src/core/config.js';
import { RateLimiter } from '../src/core/ratelimit.js';

/**
 * The typed API layer, over a mocked transport.
 *
 * This covers the behaviour that lives in `api.ts` rather than in the client:
 * per-endpoint batching and merge, historical range de-duplication, tag-based
 * reconciliation, and the GTT form encoding that is easy to get subtly wrong.
 * undici's MockAgent is used (not msw) so requests really pass through the
 * dispatcher — the same reason client.test.ts gives.
 */

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  setDispatcher(agent);
});

afterEach(async () => {
  setDispatcher(undefined);
  await agent.close();
});

const pool = () => agent.get('https://api.kite.trade');

function api(accessToken = 'testtoken'): KiteApi {
  return new KiteApi(
    new KiteClient({
      apiKey: 'testkey',
      accessToken,
      endpoints: endpointsFor('production'),
      limiter: new RateLimiter(),
    }),
  );
}

describe('quote batching', () => {
  it('returns an empty map for an empty list without making a request', async () => {
    // No interceptor + disableNetConnect means any request throws, so a clean
    // resolution proves the short-circuit fired before the network.
    await expect(api().getLtp([])).resolves.toEqual({});
    await expect(api().getQuote([])).resolves.toEqual({});
  });

  it('chunks past the per-call cap and merges the pages', async () => {
    // LTP caps at 1000 instruments per call, so 1001 forces two requests.
    const instruments = Array.from({ length: 1001 }, (_, i) => `NSE:S${i}`);
    pool()
      .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
      .reply(200, { status: 'success', data: { 'NSE:FIRST': { instrument_token: 1, last_price: 10 } } });
    pool()
      .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
      .reply(200, { status: 'success', data: { 'NSE:SECOND': { instrument_token: 2, last_price: 20 } } });

    const result = await api().getLtp(instruments);
    // Keys from both pages survive the merge.
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['NSE:FIRST', 'NSE:SECOND']));
  });
});

describe('findOrderByTag (reconciliation)', () => {
  it('matches either the tag field or an entry in the tags array', async () => {
    pool()
      .intercept({ path: '/orders', method: 'GET' })
      .reply(200, {
        status: 'success',
        data: [
          { order_id: '1', status: 'COMPLETE', tag: 'kcABC' },
          { order_id: '2', status: 'COMPLETE', tags: ['other', 'kcABC'] },
          { order_id: '3', status: 'COMPLETE', tag: 'unrelated' },
        ],
      });

    const found = await api().findOrderByTag('kcABC');
    expect(found.map((o) => o.order_id)).toEqual(['1', '2']);
  });
});

describe('historical candles', () => {
  it('merges chunked ranges and de-duplicates the inclusive boundary candle', async () => {
    // ~90 days at minute interval exceeds the 60-day cap, forcing two ranges.
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-04-01T00:00:00Z');

    pool()
      .intercept({ path: (p) => p.includes('/instruments/historical/'), method: 'GET' })
      .reply(200, {
        status: 'success',
        data: {
          candles: [
            ['2026-01-01T09:15:00+0530', 100, 101, 99, 100, 1000],
            ['2026-01-01T09:16:00+0530', 100, 101, 99, 100, 1000],
          ],
        },
      });
    pool()
      .intercept({ path: (p) => p.includes('/instruments/historical/'), method: 'GET' })
      .reply(200, {
        status: 'success',
        data: {
          candles: [
            // Repeats the last candle of the previous range — must be dropped.
            ['2026-01-01T09:16:00+0530', 100, 101, 99, 100, 1000],
            ['2026-03-01T09:15:00+0530', 100, 101, 99, 100, 1000],
          ],
        },
      });

    const candles = await api().getHistorical({ instrument_token: 408065, interval: 'minute', from, to });
    expect(candles.map((c) => c[0])).toEqual([
      '2026-01-01T09:15:00+0530',
      '2026-01-01T09:16:00+0530',
      '2026-03-01T09:15:00+0530',
    ]);
  });
});

describe('GTT serialisation', () => {
  it('encodes condition and orders as JSON strings inside the form body', async () => {
    let body = '';
    pool()
      .intercept({ path: '/gtt/triggers', method: 'POST' })
      .reply((opts) => {
        body = String(opts.body);
        return { statusCode: 200, data: { status: 'success', data: { trigger_id: 55 } } };
      });

    await api().placeGtt({
      type: 'single',
      condition: { exchange: 'NSE', tradingsymbol: 'INFY', trigger_values: [1500], last_price: 1490 },
      orders: [
        {
          exchange: 'NSE',
          tradingsymbol: 'INFY',
          transaction_type: 'BUY',
          quantity: 1,
          order_type: 'LIMIT',
          product: 'CNC',
          price: 1500,
        },
      ],
    });

    const params = new URLSearchParams(body);
    expect(params.get('type')).toBe('single');
    // condition/orders are JSON-encoded strings, not repeated form fields.
    expect(JSON.parse(params.get('condition') ?? '{}')).toMatchObject({
      tradingsymbol: 'INFY',
      trigger_values: [1500],
    });
    expect(JSON.parse(params.get('orders') ?? '[]')[0]).toMatchObject({ transaction_type: 'BUY', order_type: 'LIMIT' });
  });
});

describe('alert serialisation', () => {
  it('sends a simple constant alert as plain form fields', async () => {
    let body = '';
    pool()
      .intercept({ path: '/alerts', method: 'POST' })
      .reply((opts) => {
        body = String(opts.body);
        return {
          statusCode: 200,
          data: { status: 'success', data: { uuid: 'abc', type: 'simple', status: 'enabled' } },
        };
      });

    const created = await api().createAlert({
      name: 'NIFTY high',
      type: 'simple',
      lhs_exchange: 'INDICES',
      lhs_tradingsymbol: 'NIFTY 50',
      lhs_attribute: 'LastTradedPrice',
      operator: '>=',
      rhs_type: 'constant',
      rhs_constant: 27000,
    });

    expect(created.uuid).toBe('abc');
    const params = new URLSearchParams(body);
    expect(params.get('type')).toBe('simple');
    expect(params.get('operator')).toBe('>=');
    expect(params.get('rhs_type')).toBe('constant');
    expect(params.get('rhs_constant')).toBe('27000');
    // A constant alert must not leak instrument fields.
    expect(params.get('rhs_tradingsymbol')).toBeNull();
    // basket is only for ato.
    expect(params.get('basket')).toBeNull();
  });

  it('encodes an ATO basket as a JSON string inside a form field', async () => {
    let body = '';
    pool()
      .intercept({ path: '/alerts', method: 'POST' })
      .reply((opts) => {
        body = String(opts.body);
        return { statusCode: 200, data: { status: 'success', data: { uuid: 'xyz', type: 'ato', status: 'enabled' } } };
      });

    await api().createAlert({
      name: 'buy gold',
      type: 'ato',
      lhs_exchange: 'NSE',
      lhs_tradingsymbol: 'GOLDBEES',
      lhs_attribute: 'LastTradedPrice',
      operator: '<=',
      rhs_type: 'constant',
      rhs_constant: 71.8,
      basket: {
        name: 'kite-cli-alert',
        type: 'alert',
        tags: [],
        items: [
          {
            type: 'insert',
            tradingsymbol: 'GOLDBEES',
            exchange: 'NSE',
            weight: 10000,
            params: { transaction_type: 'BUY', order_type: 'LIMIT', product: 'CNC', quantity: 10, price: 72 },
          },
        ],
      },
    });

    const params = new URLSearchParams(body);
    expect(params.get('type')).toBe('ato');
    // basket is a JSON-encoded string, not repeated form fields.
    const basket = JSON.parse(params.get('basket') ?? '{}');
    expect(basket.items[0]).toMatchObject({ tradingsymbol: 'GOLDBEES', params: { transaction_type: 'BUY' } });
  });

  it('sends instrument-comparison fields when rhs_type is instrument', async () => {
    let body = '';
    pool()
      .intercept({ path: '/alerts', method: 'POST' })
      .reply((opts) => {
        body = String(opts.body);
        return { statusCode: 200, data: { status: 'success', data: { uuid: 'i', type: 'simple', status: 'enabled' } } };
      });

    await api().createAlert({
      name: 'pair',
      type: 'simple',
      lhs_exchange: 'NSE',
      lhs_tradingsymbol: 'INFY',
      lhs_attribute: 'LastTradedPrice',
      operator: '>',
      rhs_type: 'instrument',
      rhs_exchange: 'NSE',
      rhs_tradingsymbol: 'TCS',
      rhs_attribute: 'LastTradedPrice',
    });

    const params = new URLSearchParams(body);
    expect(params.get('rhs_type')).toBe('instrument');
    expect(params.get('rhs_tradingsymbol')).toBe('TCS');
    // An instrument comparison must not carry a stray constant.
    expect(params.get('rhs_constant')).toBeNull();
  });

  it('parses a rich ATO alert without dropping the basket or throwing on extra fields', async () => {
    // The documented ATO payload carries a nested basket with fields we never
    // send (instrument_token, gtt, validity_ttl). The loose schema must pass
    // them through rather than reject a real alert (invariant #5).
    pool()
      .intercept({ path: '/alerts', method: 'GET' })
      .reply(200, {
        status: 'success',
        data: [
          {
            type: 'ato',
            user_id: 'AB1234',
            uuid: 'e888ed4a-6801-406f-bdc2-002db5a8411d',
            name: 'buy gold',
            status: 'disabled',
            lhs_attribute: 'LastTradedPrice',
            lhs_exchange: 'NSE',
            lhs_tradingsymbol: 'GOLDBEES',
            operator: '<=',
            rhs_type: 'constant',
            rhs_constant: 71.8,
            alert_count: 1,
            basket: {
              items: [
                {
                  id: 275218517,
                  tradingsymbol: 'GOLDBEES',
                  exchange: 'NSE',
                  instrument_token: 3693569,
                  weight: 10000,
                  params: {
                    validity: 'DAY',
                    validity_ttl: 0,
                    variety: 'regular',
                    product: 'CNC',
                    order_type: 'LIMIT',
                    transaction_type: 'BUY',
                    quantity: 10000,
                    price: 72.22,
                    gtt: { target: 0, stoploss: 0 },
                    tags: [],
                  },
                },
              ],
            },
          },
        ],
      });

    const alerts = await api().getAlerts();
    expect(alerts[0]?.type).toBe('ato');
    expect(alerts[0]?.basket?.items[0]?.tradingsymbol).toBe('GOLDBEES');
    expect(alerts[0]?.basket?.items[0]?.instrument_token).toBe(3693569);
  });

  it('deletes alerts via repeated uuid query params, not a path segment', async () => {
    let requestPath = '';
    pool()
      .intercept({ path: (p) => p.startsWith('/alerts'), method: 'DELETE' })
      .reply((opts) => {
        requestPath = String(opts.path);
        return { statusCode: 200, data: { status: 'success', data: {} } };
      });

    await api().deleteAlerts(['aaa', 'bbb']);
    expect(requestPath).toContain('uuid=aaa');
    expect(requestPath).toContain('uuid=bbb');
    // The uuids are query params — they must not become path segments.
    expect(requestPath).not.toContain('/alerts/aaa');
  });
});

describe('authorisationUrl', () => {
  it('encodes the api key and request id into the CDSL authorisation URL', () => {
    const url = api().authorisationUrl('req/123');
    expect(url).toContain('/portfolio/authorise/holdings/testkey/req%2F123');
  });
});
