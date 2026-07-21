import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { z } from 'zod';
import { KiteClient, setDispatcher } from '../src/core/client.js';
import { KiteApi } from '../src/core/api.js';
import { KiteApiError, ExitCode } from '../src/core/errors.js';
import { RateLimiter } from '../src/core/ratelimit.js';
import { endpointsFor } from '../src/core/config.js';

/**
 * Client behaviour against a mocked transport.
 *
 * undici's MockAgent is used rather than MSW because the behaviour under test
 * IS the dispatcher — retries, timeouts and method restrictions. MSW
 * short-circuits above the dispatcher and would never exercise them.
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

function makeClient(accessToken = 'testtoken') {
  return new KiteClient({
    apiKey: 'testkey',
    accessToken,
    endpoints: endpointsFor('production'),
    limiter: new RateLimiter(),
  });
}

const pool = () => agent.get('https://api.kite.trade');

describe('request signing', () => {
  // MockAgent does not surface request headers to the reply callback, so these
  // assert via the interceptor's header matcher instead: a request that does
  // not carry the expected headers finds no interceptor and throws.
  it('sends X-Kite-Version and the Authorization header', async () => {
    pool()
      .intercept({
        path: '/user/profile',
        method: 'GET',
        headers: { 'X-Kite-Version': '3', Authorization: 'token testkey:testtoken' },
      })
      .reply(200, { status: 'success', data: { user_id: 'AB1234' } });

    const profile = await new KiteApi(makeClient()).getProfile();
    expect(profile.user_id).toBe('AB1234');
  });

  it('omits the Authorization header when there is no session', async () => {
    pool()
      .intercept({
        path: '/user/profile',
        method: 'GET',
        headers: (headers) => !('authorization' in headers) && !('Authorization' in headers),
      })
      .reply(200, { status: 'success', data: { user_id: 'AB1234' } });

    const client = new KiteClient({
      apiKey: 'testkey',
      endpoints: endpointsFor('production'),
      limiter: new RateLimiter(),
    });
    const profile = await new KiteApi(client).getProfile();
    expect(profile.user_id).toBe('AB1234');
  });
});

describe('error mapping', () => {
  it('maps TokenException to the auth exit code', async () => {
    pool()
      .intercept({ path: '/user/profile', method: 'GET' })
      .reply(403, { status: 'error', message: 'Invalid token', error_type: 'TokenException' });

    const error = await new KiteApi(makeClient()).getProfile().catch((e) => e);
    expect(error).toBeInstanceOf(KiteApiError);
    expect(error.exitCode).toBe(ExitCode.Auth);
    expect(error.hint).toMatch(/kite login/);
  });

  it('maps MarginException to the margin exit code', async () => {
    pool()
      .intercept({ path: '/orders/regular', method: 'POST' })
      .reply(400, { status: 'error', message: 'Insufficient funds', error_type: 'MarginException' });

    const error = await new KiteApi(makeClient())
      .placeOrder({
        variety: 'regular',
        tradingsymbol: 'INFY',
        exchange: 'NSE',
        transaction_type: 'BUY',
        order_type: 'MARKET',
        quantity: 1,
        product: 'CNC',
      })
      .catch((e) => e);

    expect(error.exitCode).toBe(ExitCode.Margin);
  });

  it('maps HTTP 428 to the depository authorisation exit code', async () => {
    pool()
      .intercept({ path: '/orders/regular', method: 'POST' })
      .reply(428, {
        status: 'error',
        message: '10 quantity needs authorisation at depository',
        error_type: 'OrderException',
      });

    const error = await new KiteApi(makeClient())
      .placeOrder({
        variety: 'regular',
        tradingsymbol: 'INFY',
        exchange: 'NSE',
        transaction_type: 'SELL',
        order_type: 'MARKET',
        quantity: 10,
        product: 'CNC',
      })
      .catch((e) => e);

    // 428 is unambiguous and must win over the generic OrderException Kite
    // pairs it with — otherwise the documented exit code is unreachable and a
    // script cannot branch on the one error with a specific recovery flow.
    expect(error.exitCode).toBe(ExitCode.AuthorisationRequired);
    expect(error.hint).toMatch(/authorisation/i);
  });

  it('maps every documented exit code to a reachable condition', async () => {
    const cases: Array<[number, string, number]> = [
      [403, 'TokenException', ExitCode.Auth],
      [400, 'InputException', ExitCode.Input],
      [400, 'OrderException', ExitCode.Order],
      [400, 'MarginException', ExitCode.Margin],
      [400, 'HoldingException', ExitCode.Holding],
      [429, 'NetworkException', ExitCode.RateLimit],
      [428, 'OrderException', ExitCode.AuthorisationRequired],
      [503, 'NetworkException', ExitCode.Upstream],
    ];

    for (const [status, errorType, expected] of cases) {
      const error = new KiteApiError({ message: 'x', status, errorType });
      expect(error.exitCode, `${status} ${errorType}`).toBe(expected);
    }
  });

  it('handles HTTP 200 carrying status:error in the envelope', async () => {
    pool()
      .intercept({ path: '/user/profile', method: 'GET' })
      .reply(200, { status: 'error', message: 'Something broke', error_type: 'GeneralException' });

    const error = await new KiteApi(makeClient()).getProfile().catch((e) => e);
    expect(error).toBeInstanceOf(KiteApiError);
    expect(error.message).toBe('Something broke');
  });

  it('reports a non-JSON error body without crashing', async () => {
    pool().intercept({ path: '/user/profile', method: 'GET' }).reply(502, '<html>Bad Gateway</html>');

    const error = await new KiteApi(makeClient()).getProfile().catch((e) => e);
    expect(error).toBeInstanceOf(KiteApiError);
    expect(error.exitCode).toBe(ExitCode.Upstream);
  });

  it('never leaks the access token in an error message', async () => {
    pool()
      .intercept({ path: '/user/profile', method: 'GET' })
      .reply(400, {
        status: 'error',
        // A hostile or careless API echoing the token back at us.
        message: 'Bad request with token testtoken',
        error_type: 'InputException',
      });

    const error = await new KiteApi(makeClient('testtoken')).getProfile().catch((e) => e);
    expect(error.message).not.toContain('testtoken');
  });
});

describe('response validation', () => {
  it('accepts unknown extra fields so a new Kite field cannot break the CLI', async () => {
    pool()
      .intercept({ path: '/user/profile', method: 'GET' })
      .reply(200, {
        status: 'success',
        data: { user_id: 'AB1234', brand_new_field_kite_just_added: 'surprise' },
      });

    const profile = await new KiteApi(makeClient()).getProfile();
    expect(profile.user_id).toBe('AB1234');
  });

  it('rejects a response missing a field we depend on', async () => {
    pool()
      .intercept({ path: '/user/profile', method: 'GET' })
      .reply(200, { status: 'success', data: { no_user_id_here: true } });

    const error = await new KiteApi(makeClient()).getProfile().catch((e) => e);
    expect(error).toBeInstanceOf(KiteApiError);
    expect(error.errorType).toBe('DataException');
  });
});

describe('retry policy', () => {
  /**
   * The single most important transport test.
   *
   * undici retries PUT and DELETE by default. In this API PUT is "modify
   * order" and DELETE is "cancel order", and Kite hard-caps modifications at
   * 25 per order with no idempotency key anywhere. Automatic retries of
   * mutating verbs are a real-money bug.
   */
  it('does NOT retry POST (order placement)', async () => {
    let attempts = 0;
    pool()
      .intercept({ path: '/orders/regular', method: 'POST' })
      .reply(() => {
        attempts += 1;
        return { statusCode: 503, data: { status: 'error', message: 'down', error_type: 'NetworkException' } };
      })
      .times(4);

    await new KiteApi(makeClient())
      .placeOrder({
        variety: 'regular',
        tradingsymbol: 'INFY',
        exchange: 'NSE',
        transaction_type: 'BUY',
        order_type: 'MARKET',
        quantity: 1,
        product: 'CNC',
      })
      .catch(() => undefined);

    expect(attempts).toBe(1);
  });

  it('does NOT retry PUT (order modification)', async () => {
    let attempts = 0;
    pool()
      .intercept({ path: /\/orders\/regular\/.*/, method: 'PUT' })
      .reply(() => {
        attempts += 1;
        return { statusCode: 503, data: { status: 'error', message: 'down', error_type: 'NetworkException' } };
      })
      .times(4);

    await new KiteApi(makeClient())
      .modifyOrder({ variety: 'regular', order_id: '123', quantity: 5 })
      .catch(() => undefined);

    expect(attempts).toBe(1);
  });

  it('does NOT retry DELETE (order cancellation)', async () => {
    let attempts = 0;
    pool()
      .intercept({ path: /\/orders\/regular\/.*/, method: 'DELETE' })
      .reply(() => {
        attempts += 1;
        return { statusCode: 503, data: { status: 'error', message: 'down', error_type: 'NetworkException' } };
      })
      .times(4);

    await new KiteApi(makeClient())
      .cancelOrder({ variety: 'regular', order_id: '123' })
      .catch(() => undefined);

    expect(attempts).toBe(1);
  });
});

describe('quote batching', () => {
  it('splits a large LTP request into chunks of 1000 and merges the results', async () => {
    const instruments = Array.from({ length: 1500 }, (_, i) => `NSE:SYM${i}`);
    const seenCounts: number[] = [];

    pool()
      .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
      .reply((opts) => {
        const url = new URL(`https://api.kite.trade${opts.path}`);
        const keys = url.searchParams.getAll('i');
        seenCounts.push(keys.length);
        return {
          statusCode: 200,
          data: {
            status: 'success',
            data: Object.fromEntries(keys.map((k, i) => [k, { instrument_token: i, last_price: 100 }])),
          },
        };
      })
      .times(2);

    const result = await new KiteApi(makeClient()).getLtp(instruments);

    expect(seenCounts).toEqual([1000, 500]);
    expect(Object.keys(result)).toHaveLength(1500);
  });

  it('returns an empty object without calling the API for an empty list', async () => {
    const result = await new KiteApi(makeClient()).getLtp([]);
    expect(result).toEqual({});
  });

  it('omits instruments Kite has no data for rather than inventing them', async () => {
    pool()
      .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
      .reply(200, {
        status: 'success',
        // Only one of the two requested keys comes back — Kite's real behaviour
        // for an expired or invalid instrument.
        data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
      });

    const result = await new KiteApi(makeClient()).getLtp(['NSE:INFY', 'NSE:EXPIRED']);
    expect(result['NSE:INFY']).toBeDefined();
    expect(result['NSE:EXPIRED']).toBeUndefined();
  });
});

describe('order reconciliation', () => {
  it('finds a previously placed order by its tag', async () => {
    pool()
      .intercept({ path: '/orders', method: 'GET' })
      .reply(200, {
        status: 'success',
        data: [
          { order_id: '111', status: 'COMPLETE', tag: 'kcabc123' },
          { order_id: '222', status: 'OPEN', tag: 'other' },
        ],
      });

    const matches = await new KiteApi(makeClient()).findOrderByTag('kcabc123');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.order_id).toBe('111');
  });
});

describe('sandbox routing', () => {
  it('prefixes API routes with /oms', async () => {
    const sandboxAgent = new MockAgent();
    sandboxAgent.disableNetConnect();
    setDispatcher(sandboxAgent);

    let called = false;
    sandboxAgent
      .get('https://sandbox.kite.trade')
      .intercept({ path: '/oms/user/profile', method: 'GET' })
      .reply(200, () => {
        called = true;
        return { status: 'success', data: { user_id: 'SB1234' } };
      });

    const client = new KiteClient({
      apiKey: 'sandboxdemo',
      accessToken: 'tok',
      endpoints: endpointsFor('sandbox'),
      limiter: new RateLimiter(),
    });
    await new KiteApi(client).getProfile();

    expect(called).toBe(true);
    await sandboxAgent.close();
  });

  it('does NOT prefix /instruments, which the sandbox serves unprefixed', async () => {
    const sandboxAgent = new MockAgent();
    sandboxAgent.disableNetConnect();
    setDispatcher(sandboxAgent);

    sandboxAgent
      .get('https://sandbox.kite.trade')
      .intercept({ path: '/instruments', method: 'GET' })
      .reply(200, 'instrument_token,tradingsymbol,exchange\n1,INFY,NSE\n');

    const client = new KiteClient({
      apiKey: 'sandboxdemo',
      accessToken: 'tok',
      endpoints: endpointsFor('sandbox'),
      limiter: new RateLimiter(),
    });
    const csv = await new KiteApi(client).getInstrumentsCsv();

    expect(csv).toContain('INFY');
    await sandboxAgent.close();
  });
});

describe('GTT serialisation', () => {
  it('sends condition and orders as JSON strings inside form fields', async () => {
    let body = '';
    pool()
      .intercept({ path: '/gtt/triggers', method: 'POST' })
      .reply(200, (opts) => {
        body = String(opts.body);
        return { status: 'success', data: { trigger_id: 99 } };
      });

    await new KiteApi(makeClient()).placeGtt({
      type: 'single',
      condition: { exchange: 'NSE', tradingsymbol: 'INFY', trigger_values: [1400], last_price: 1500 },
      orders: [
        {
          exchange: 'NSE',
          tradingsymbol: 'INFY',
          transaction_type: 'BUY',
          quantity: 1,
          order_type: 'LIMIT',
          product: 'CNC',
          price: 1400,
        },
      ],
    });

    const params = new URLSearchParams(body);
    expect(params.get('type')).toBe('single');
    // Not a JSON body, and not flattened form fields — JSON strings in fields.
    expect(JSON.parse(params.get('condition')!)).toMatchObject({ tradingsymbol: 'INFY' });
    expect(JSON.parse(params.get('orders')!)).toHaveLength(1);
  });
});

describe('holdings authorisation', () => {
  it('encodes multiple ISINs as repeated form fields', async () => {
    let body = '';
    pool()
      .intercept({ path: '/portfolio/holdings/authorise', method: 'POST' })
      .reply(200, (opts) => {
        body = String(opts.body);
        return { status: 'success', data: { request_id: 'req123' } };
      });

    await new KiteApi(makeClient()).authoriseHoldings(['INE009A01021', 'INE467B01029']);

    // Repeated fields, not comma-joined or JSON — this is the shape Kite wants.
    const params = new URLSearchParams(body);
    expect(params.getAll('isin')).toEqual(['INE009A01021', 'INE467B01029']);
  });

  it('sends no isin field when authorising the whole account', async () => {
    let body = '';
    pool()
      .intercept({ path: '/portfolio/holdings/authorise', method: 'POST' })
      .reply(200, (opts) => {
        // An empty form body surfaces as a stream rather than '', so assert on
        // the absence of the field rather than on an exact serialisation.
        body = String(opts.body);
        return { status: 'success', data: { request_id: 'req456' } };
      });

    const result = await new KiteApi(makeClient()).authoriseHoldings();
    expect(body).not.toContain('isin');
    expect(result.request_id).toBe('req456');
  });

  it('builds the browser URL the user must visit', () => {
    const url = new KiteApi(makeClient()).authorisationUrl('req123');
    expect(url).toBe('https://kite.zerodha.com/connect/portfolio/authorise/holdings/testkey/req123');
  });
});

describe('margin calculator', () => {
  it('sends a JSON body, unlike the form-encoded rest of the API', async () => {
    let body = '';
    pool()
      .intercept({
        path: '/margins/orders',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      .reply(200, (opts) => {
        body = String(opts.body);
        return { status: 'success', data: [{ total: 1500 }] };
      });

    await new KiteApi(makeClient()).orderMargins([{ exchange: 'NSE', tradingsymbol: 'INFY' }]);

    // Reaching here at all proves the Content-Type matched the interceptor.
    expect(JSON.parse(body)).toHaveLength(1);
  });
});
