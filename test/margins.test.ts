import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseOrderSpec } from '../src/commands/margins.js';
import { setDispatcher } from '../src/core/client.js';
import { ExitCode } from '../src/core/errors.js';
import { configDir } from '../src/core/paths.js';
import { run } from '../src/run.js';

describe('parseOrderSpec (margins)', () => {
  it('parses a full spec including variety, order-insensitive', () => {
    expect(parseOrderSpec('NFO:NIFTY25AUGFUT:BUY:75:MARKET:NRML:regular')).toEqual({
      exchange: 'NFO',
      tradingsymbol: 'NIFTY25AUGFUT',
      transactionType: 'BUY',
      quantity: 75,
      orderType: 'MARKET',
      product: 'NRML',
      variety: 'regular',
      price: undefined,
      triggerPrice: undefined,
    });
    expect(parseOrderSpec('NFO:NIFTY25AUGFUT:BUY:75:NRML:MARKET')).toMatchObject({
      orderType: 'MARKET',
      product: 'NRML',
    });
  });

  it('defaults product to CNC, variety to regular, order type to MARKET', () => {
    expect(parseOrderSpec('NSE:INFY:BUY:1')).toMatchObject({
      orderType: 'MARKET',
      product: 'CNC',
      variety: 'regular',
      price: undefined,
    });
  });

  it('reads a bare number as the price', () => {
    expect(parseOrderSpec('NSE:INFY:BUY:10:LIMIT:1500')).toMatchObject({ orderType: 'LIMIT', price: 1500 });
  });

  it.each([
    ['too few fields', 'NSE:INFY:BUY'],
    ['bad side', 'NSE:INFY:HOLD:1'],
    ['non-integer quantity', 'NSE:INFY:BUY:1.5'],
    ['unrecognised token', 'NSE:INFY:BUY:1:XYZ'],
    ['duplicate category', 'NSE:INFY:BUY:1:MIS:NRML'],
    ['two bare numbers', 'NSE:INFY:BUY:1:1500:1600'],
    ['empty field', 'NSE:INFY:BUY:1:MARKET:'],
    ['unknown key', 'NSE:INFY:BUY:1:foo=bar'],
  ])('rejects %s', (_label, spec) => {
    expect(() => parseOrderSpec(spec)).toThrow();
  });
});

describe('margins commands (through run)', () => {
  let agent: MockAgent;
  let stdout: PassThrough;
  let stderr: PassThrough;
  let out: string;
  let err: string;

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
    process.env['KITE_ACCESS_TOKEN'] = 'testaccesstoken';
    process.env['KITE_API_KEY'] = 'testkey';
  });

  afterEach(async () => {
    setDispatcher(undefined);
    await agent.close();
    delete process.env['KITE_ACCESS_TOKEN'];
    delete process.env['KITE_API_KEY'];
  });

  const pool = () => agent.get('https://api.kite.trade');
  function invoke(args: string[]) {
    return run({ argv: ['node', 'kite', ...args], streams: { stdout, stderr } });
  }

  it('order: posts price/trigger_price order objects and renders margins', async () => {
    let body = '';
    pool()
      .intercept({ path: '/margins/orders', method: 'POST' })
      .reply((opts) => {
        body = String(opts.body);
        return {
          statusCode: 200,
          data: {
            status: 'success',
            data: [{ tradingsymbol: 'NIFTY25AUGFUT', exchange: 'NFO', span: 100000, exposure: 50000, total: 150000 }],
          },
        };
      });

    const code = await invoke(['margins', 'order', 'NFO:NIFTY25AUGFUT:BUY:75:NRML', '--json']);
    expect(code).toBe(ExitCode.Ok);
    const sent = JSON.parse(body);
    expect(sent[0]).toMatchObject({
      exchange: 'NFO',
      tradingsymbol: 'NIFTY25AUGFUT',
      transaction_type: 'BUY',
      product: 'NRML',
      quantity: 75,
      price: 0,
      trigger_price: 0,
    });
    expect(JSON.parse(out)[0].total).toBe(150000);
  });

  it('basket: passes consider_positions=true by default', async () => {
    let path = '';
    pool()
      .intercept({ path: (p) => p.startsWith('/margins/basket'), method: 'POST' })
      .reply((opts) => {
        path = opts.path;
        return {
          statusCode: 200,
          data: { status: 'success', data: { initial: { total: 200000 }, final: { total: 150000 }, orders: [] } },
        };
      });

    const code = await invoke(['margins', 'basket', 'NFO:NIFTY25AUGFUT:BUY:75:NRML', '--json']);
    expect(code).toBe(ExitCode.Ok);
    expect(path).toContain('consider_positions=true');
    expect(JSON.parse(out).final.total).toBe(150000);
  });

  it('basket: --no-consider-positions passes consider_positions=false', async () => {
    let path = '';
    pool()
      .intercept({ path: (p) => p.startsWith('/margins/basket'), method: 'POST' })
      .reply((opts) => {
        path = opts.path;
        return { statusCode: 200, data: { status: 'success', data: { orders: [] } } };
      });

    const code = await invoke([
      'margins',
      'basket',
      '--no-consider-positions',
      'NFO:NIFTY25AUGFUT:BUY:75:NRML',
      '--json',
    ]);
    expect(code).toBe(ExitCode.Ok);
    expect(path).toContain('consider_positions=false');
  });

  it('charges: posts average_price + order_id and renders totals', async () => {
    let body = '';
    pool()
      .intercept({ path: '/charges/orders', method: 'POST' })
      .reply((opts) => {
        body = String(opts.body);
        return {
          statusCode: 200,
          data: {
            status: 'success',
            data: [{ tradingsymbol: 'INFY', exchange: 'NSE', charges: { brokerage: 20, total: 23.5 } }],
          },
        };
      });

    const code = await invoke(['margins', 'charges', 'NSE:INFY:BUY:10:LIMIT:1500', '--json']);
    expect(code).toBe(ExitCode.Ok);
    const sent = JSON.parse(body);
    expect(sent[0]).toMatchObject({ order_id: '1', average_price: 1500, quantity: 10 });
    expect(sent[0].price).toBeUndefined();
    expect(JSON.parse(out)[0].charges.total).toBe(23.5);
  });

  it('charges: rejects a zero/absent price (would silently compute ~0)', async () => {
    // MARKET order, no price given — charges must refuse rather than send price 0.
    const code = await invoke(['margins', 'charges', 'NSE:INFY:BUY:10']);
    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/non-zero price/i);
  });
});
