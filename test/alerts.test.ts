import { mkdir, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseOrderSpec } from '../src/commands/alerts.js';
import { setDispatcher } from '../src/core/client.js';
import { ExitCode } from '../src/core/errors.js';
import { configDir, configFile, sessionFile } from '../src/core/paths.js';
import { run } from '../src/run.js';

/**
 * ATO basket tests.
 *
 * `parseOrderSpec` is exercised directly (it is a pure parser). The multi-leg
 * creation path and its fail-closed value-cap behaviour go through run() with a
 * mocked API, the same in-process harness the safety suite uses.
 */

describe('parseOrderSpec', () => {
  it('parses a compact MARKET leg (fields order-insensitive)', () => {
    expect(parseOrderSpec('NFO:INDIGO25AUGFUT:BUY:150:MARKET:NRML')).toEqual({
      exchange: 'NFO',
      tradingsymbol: 'INDIGO25AUGFUT',
      side: 'BUY',
      quantity: 150,
      orderType: 'MARKET',
      price: undefined,
      triggerPrice: undefined,
      product: 'NRML',
      validity: 'DAY',
    });
    // Same leg, attributes swapped — content-based parsing must agree.
    expect(parseOrderSpec('NFO:INDIGO25AUGFUT:BUY:150:NRML:MARKET')).toMatchObject({
      orderType: 'MARKET',
      product: 'NRML',
    });
  });

  it('reads a bare number as the price on a LIMIT leg', () => {
    expect(parseOrderSpec('NSE:RELIANCE:SELL:10:LIMIT:2900')).toMatchObject({
      side: 'SELL',
      orderType: 'LIMIT',
      price: 2900,
      product: 'CNC',
    });
  });

  it('defaults order type to MARKET and product to CNC', () => {
    expect(parseOrderSpec('NSE:INFY:BUY:1')).toMatchObject({
      orderType: 'MARKET',
      product: 'CNC',
      validity: 'DAY',
      price: undefined,
    });
  });

  it('takes an SL leg only with an explicit trigger= (never positionally)', () => {
    expect(parseOrderSpec('NSE:INFY:BUY:1:SL:100:trigger=99')).toMatchObject({
      orderType: 'SL',
      price: 100,
      triggerPrice: 99,
    });
  });

  it('accepts explicit key=value attributes', () => {
    expect(parseOrderSpec('NSE:INFY:BUY:1:type=LIMIT:price=105:validity=IOC')).toMatchObject({
      orderType: 'LIMIT',
      price: 105,
      validity: 'IOC',
    });
  });

  // --- fail-closed rejections (a mis-parsed leg is a real order gone wrong) ---

  it.each([
    ['too few fields', 'NSE:INFY:BUY'],
    ['bad side', 'NSE:INFY:HOLD:1'],
    ['non-integer quantity', 'NSE:INFY:BUY:1.5'],
    ['zero quantity', 'NSE:INFY:BUY:0'],
    ['unrecognised token', 'NSE:INFY:BUY:1:NRLM'],
    ['duplicate category', 'NSE:INFY:BUY:1:CNC:NRML'],
    ['two bare numbers (second is not a trigger)', 'NSE:INFY:BUY:1:LIMIT:100:105'],
    ['empty trailing field', 'NSE:INFY:BUY:1:MARKET:'],
    ['unknown key', 'NSE:INFY:BUY:1:foo=bar'],
    ['MARKET with a price', 'NSE:INFY:BUY:1:MARKET:100'],
    ['LIMIT without a price', 'NSE:INFY:BUY:1:LIMIT'],
    ['SL without a trigger', 'NSE:INFY:BUY:1:SL:100'],
  ])('rejects %s', (_label, spec) => {
    expect(() => parseOrderSpec(spec)).toThrow();
  });
});

describe('alerts create --order (through run)', () => {
  let agent: MockAgent;
  let stdout: PassThrough;
  let stderr: PassThrough;
  let out: string;
  let err: string;

  async function seedSession(config: Record<string, unknown> = {}) {
    await mkdir(configDir(), { recursive: true });
    await writeFile(configFile(), JSON.stringify({ apiKey: 'testkey', env: 'production', ...config }), 'utf8');
    await writeFile(
      sessionFile(),
      JSON.stringify({
        userId: 'AB1234',
        env: 'production',
        apiKey: 'testkey',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        exchanges: [],
        products: [],
      }),
      'utf8',
    );
    process.env['KITE_ACCESS_TOKEN'] = 'testaccesstoken';
    process.env['KITE_API_KEY'] = 'testkey';
  }

  beforeEach(async () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setDispatcher(agent);
    stdout = new PassThrough();
    stderr = new PassThrough();
    out = '';
    err = '';
    stdout.on('data', (chunk) => (out += chunk));
    stderr.on('data', (chunk) => (err += chunk));
    await rm(configDir(), { recursive: true, force: true });
  });

  afterEach(async () => {
    setDispatcher(undefined);
    await agent.close();
    delete process.env['KITE_ACCESS_TOKEN'];
    delete process.env['KITE_API_KEY'];
  });

  function invoke(args: string[]) {
    return run({ argv: ['node', 'kite', ...args], streams: { stdout, stderr } });
  }

  it('builds a multi-leg basket on instruments other than the watched one', async () => {
    await seedSession({ trading: { enabled: true } });
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(200, {
      status: 'success',
      data: {
        'NFO:INDIGO25AUGFUT': { instrument_token: 1, last_price: 5300 },
        'NSE:RELIANCE': { instrument_token: 2, last_price: 2900 },
      },
    });
    let body = '';
    pool.intercept({ path: '/alerts', method: 'POST' }).reply((opts) => {
      body = String(opts.body);
      return { statusCode: 200, data: { status: 'success', data: { uuid: 'abc', type: 'ato', status: 'enabled' } } };
    });

    const code = await invoke([
      'alerts',
      'create',
      'NSE:INDIGO',
      '-o',
      'below',
      '--value',
      '3850',
      '--type',
      'ato',
      '--order',
      'NFO:INDIGO25AUGFUT:BUY:150:MARKET:NRML',
      '--order',
      'NSE:RELIANCE:SELL:10:LIMIT:2900',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.Ok);
    const basket = JSON.parse(new URLSearchParams(body).get('basket') ?? '{}');
    expect(basket.items).toHaveLength(2);
    // The watched instrument (NSE:INDIGO) is not itself in the basket.
    expect(basket.items[0]).toMatchObject({
      exchange: 'NFO',
      tradingsymbol: 'INDIGO25AUGFUT',
      params: { transaction_type: 'BUY', order_type: 'MARKET', product: 'NRML', quantity: 150 },
    });
    expect(basket.items[1]).toMatchObject({
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      params: { transaction_type: 'SELL', order_type: 'LIMIT', price: 2900, quantity: 10 },
    });
  });

  it('fails closed when a single leg cannot be priced and a cap is set', async () => {
    await seedSession({ trading: { enabled: true, maxOrderValue: 1_000_000 } });
    const pool = agent.get('https://api.kite.trade');
    // Only RELIANCE comes back; the FUT leg has no price, so the total is unknown.
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(200, {
      status: 'success',
      data: { 'NSE:RELIANCE': { instrument_token: 2, last_price: 2900 } },
    });

    const code = await invoke([
      'alerts',
      'create',
      'NSE:INDIGO',
      '-o',
      'below',
      '--value',
      '3850',
      '--type',
      'ato',
      '--order',
      'NFO:INDIGO25AUGFUT:BUY:150:MARKET:NRML',
      '--order',
      'NSE:RELIANCE:SELL:10:LIMIT:2900',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.TradingDisabled);
    expect(err).toMatch(/cannot verify/i);
  });

  it('applies the value cap to the basket total, not per leg', async () => {
    // Cap sits above either single leg but below their sum: 150·5300 = 795,000
    // and 10·2900 = 29,000 each clear 800,000, but together they are 824,000.
    await seedSession({ trading: { enabled: true, maxOrderValue: 800_000 } });
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(200, {
      status: 'success',
      data: { 'NFO:INDIGO25AUGFUT': { instrument_token: 1, last_price: 5300 } },
    });

    const code = await invoke([
      'alerts',
      'create',
      'NSE:INDIGO',
      '-o',
      'below',
      '--value',
      '3850',
      '--type',
      'ato',
      '--order',
      'NFO:INDIGO25AUGFUT:BUY:150:MARKET:NRML',
      '--order',
      'NSE:RELIANCE:SELL:10:LIMIT:2900',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.TradingDisabled);
  });

  it('refuses to mix --order with the single-order flags', async () => {
    await seedSession({ trading: { enabled: true } });
    const code = await invoke([
      'alerts',
      'create',
      'NSE:INDIGO',
      '-o',
      'below',
      '--value',
      '3850',
      '--type',
      'ato',
      '--order',
      'NSE:RELIANCE:SELL:10:LIMIT:2900',
      '--side',
      'BUY',
      '--quantity',
      '1',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/either --order/i);
  });

  it('rejects --product alongside --order (never silently ignores it)', async () => {
    await seedSession({ trading: { enabled: true } });
    const code = await invoke([
      'alerts',
      'create',
      'NSE:INDIGO',
      '-o',
      'below',
      '--value',
      '3850',
      '--type',
      'ato',
      '--order',
      'NFO:INDIGO25AUGFUT:BUY:150',
      '--product',
      'NRML',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/either --order/i);
  });
});
