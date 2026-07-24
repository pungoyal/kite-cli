import { mkdir, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDispatcher } from '../src/core/client.js';
import { ExitCode } from '../src/core/errors.js';
import { configDir, configFile, sessionFile } from '../src/core/paths.js';
import { run } from '../src/run.js';

/**
 * `kite gtt place`, driven through run() in-process.
 *
 * Almost every case is a --dry-run against a MockAgent with net connect
 * disabled, so a request that escaped would throw rather than pass silently.
 * `gtt place` makes no network call of its own — it does not price the
 * instrument, because Kite does not need it to — and several tests below rely
 * on that: they register no interceptor at all.
 */

let agent: MockAgent;
let stdout: PassThrough;
let stderr: PassThrough;
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
  err = '';
  stdout.on('data', () => {});
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

/** MCX copper, the contract the live API probes were run against. */
const COPPER = ['gtt', 'place', 'MCX:COPPER26AUGFUT', '-s', 'BUY', '-q', '1', '--product', 'NRML'];
const INFY = ['gtt', 'place', 'NSE:INFY', '-s', 'SELL', '-q', '10'];

interface GttFormBody {
  type: string;
  condition: {
    exchange: string;
    tradingsymbol: string;
    trigger_values: number[];
    /** Asserted absent: the CLI must not invent a price Kite computes itself. */
    last_price?: number;
  };
  orders: Array<Record<string, unknown>>;
}

/** Captures the form body of a POST /gtt/triggers, and returns the parsed payload. */
function interceptPlace(): { body: () => GttFormBody } {
  let raw = '';
  agent
    .get('https://api.kite.trade')
    .intercept({ path: '/gtt/triggers', method: 'POST' })
    .reply((opts) => {
      raw = String(opts.body);
      return { statusCode: 200, data: { status: 'success', data: { trigger_id: 42 } } };
    });
  return {
    body: () => {
      const params = new URLSearchParams(raw);
      return {
        type: params.get('type') ?? '',
        condition: JSON.parse(params.get('condition') ?? '{}'),
        orders: JSON.parse(params.get('orders') ?? '[]'),
      };
    },
  };
}

describe('gtt place: OCO at market', () => {
  it('places a two-leg market GTT from named legs', async () => {
    await seedSession();
    const captured = interceptPlace();

    const code = await invoke([...COPPER, '--stoploss', '1500', '--target', '900', '-t', 'MARKET', '--yes']);

    expect(code).toBe(ExitCode.Ok);
    const { type, condition, orders } = captured.body();
    expect(type).toBe('two-leg');
    // A BUY OCO closes a short: stoploss above, target below — and the wire
    // array ascends regardless of the order the flags were given in.
    expect(condition.trigger_values).toEqual([900, 1500]);
    // Kite does not need last_price and computes it from its own feed, so the
    // CLI must not invent one.
    expect(condition).not.toHaveProperty('last_price');
    expect(orders).toHaveLength(2);
    for (const order of orders) {
      expect(order).toMatchObject({
        order_type: 'MARKET',
        price: 0,
        market_protection: -1,
        product: 'NRML',
        transaction_type: 'BUY',
        quantity: 1,
      });
    }
  });

  it('puts the stoploss below the price for a SELL OCO', async () => {
    await seedSession();
    const captured = interceptPlace();

    const code = await invoke([
      'gtt',
      'place',
      'NSE:INFY',
      '-s',
      'SELL',
      '-q',
      '10',
      '--stoploss',
      '1400',
      '--target',
      '1700',
      '-t',
      'MARKET',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.Ok);
    expect(captured.body().condition.trigger_values).toEqual([1400, 1700]);
  });

  it('names each leg in the confirmation rather than numbering them', async () => {
    await seedSession();

    const code = await invoke([...COPPER, '--stoploss', '1500', '--target', '900', '-t', 'MARKET', '--dry-run']);

    expect(code).toBe(ExitCode.Ok);
    // Stoploss first, as Kite web lists them — not the ascending wire order.
    expect(err).toMatch(/Stoploss.*1,500\.00.*MARKET/);
    expect(err).toMatch(/Target.*900\.00.*MARKET/);
    expect(err.indexOf('Stoploss')).toBeLessThan(err.indexOf('Target'));
  });

  it('estimates value from the trigger, never from the 0 sent on the wire', async () => {
    await seedSession();

    const code = await invoke([
      'gtt',
      'place',
      'MCX:COPPER26AUGFUT',
      '-s',
      'BUY',
      '-q',
      '4',
      '--product',
      'NRML',
      '--stoploss',
      '1500',
      '--target',
      '900',
      '-t',
      'MARKET',
      '--dry-run',
    ]);

    expect(code).toBe(ExitCode.Ok);
    // 1500 x 4 = 6,000. A 0 fallback would print ₹0.00 and make an arbitrarily
    // large order read as tiny to the cap and the confirmation threshold.
    expect(err).toMatch(/Est\. value/);
    expect(err).toMatch(/6,000/);
    expect(err).not.toMatch(/₹0\.00/);
  });

  it('still refuses a market GTT that exceeds the configured value cap', async () => {
    await seedSession({ trading: { maxOrderValue: 1000 } });

    const code = await invoke([...COPPER, '--stoploss', '1500', '--target', '900', '-t', 'MARKET', '--yes']);

    expect(code).toBe(ExitCode.TradingDisabled);
    expect(err).toMatch(/exceeds your configured cap/);
  });
});

describe('gtt place: OCO at limit', () => {
  it('prices each leg separately', async () => {
    await seedSession();
    const captured = interceptPlace();

    const code = await invoke([
      ...INFY,
      '--stoploss',
      '1400',
      '--stoploss-price',
      '1395',
      '--target',
      '1700',
      '--target-price',
      '1695',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.Ok);
    const { condition, orders } = captured.body();
    expect(condition.trigger_values).toEqual([1400, 1700]);
    // Prices ride with their own leg through the sort into wire order.
    expect(orders[0]).toMatchObject({ order_type: 'LIMIT', price: 1395 });
    expect(orders[1]).toMatchObject({ order_type: 'LIMIT', price: 1695 });
    expect(orders[0]).not.toHaveProperty('market_protection');
  });

  it('infers LIMIT from the presence of prices', async () => {
    await seedSession();

    const code = await invoke([
      ...INFY,
      '--stoploss',
      '1400',
      '--stoploss-price',
      '1395',
      '--target',
      '1700',
      '--target-price',
      '1695',
      '--dry-run',
    ]);

    expect(code).toBe(ExitCode.Ok);
    expect(err).toMatch(/Max value/);
    expect(err).not.toMatch(/Est\. value/);
  });

  it('refuses a LIMIT OCO with only one leg priced', async () => {
    await seedSession();

    const code = await invoke([...INFY, '--stoploss', '1400', '--stoploss-price', '1395', '--target', '1700']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/needs a price for both legs/);
  });
});

describe('gtt place: single leg', () => {
  it('places one limit order', async () => {
    await seedSession();
    const captured = interceptPlace();

    const code = await invoke([...INFY, '--trigger', '1700', '--price', '1695', '--yes']);

    expect(code).toBe(ExitCode.Ok);
    const { type, condition, orders } = captured.body();
    expect(type).toBe('single');
    expect(condition.trigger_values).toEqual([1700]);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ order_type: 'LIMIT', price: 1695 });
  });

  it('places one market order', async () => {
    await seedSession();
    const captured = interceptPlace();

    const code = await invoke([...INFY, '--trigger', '1700', '-t', 'MARKET', '--yes']);

    expect(code).toBe(ExitCode.Ok);
    expect(captured.body().orders[0]).toMatchObject({ order_type: 'MARKET', price: 0, market_protection: -1 });
  });

  it('needs a price or an explicit market', async () => {
    await seedSession();

    const code = await invoke([...INFY, '--trigger', '1700']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/order type has to be explicit/);
    // MARKET is never inferred from a missing price: a mistyped --price flag
    // must not become a market order.
    expect(err).toMatch(/--order-type MARKET/);
  });
});

describe('gtt place: percentage triggers', () => {
  it('measures an unsigned percentage from --last-price, in each leg direction', async () => {
    await seedSession();
    const captured = interceptPlace();

    const code = await invoke([
      ...COPPER,
      '--last-price',
      '1331.5',
      '--stoploss',
      '2%',
      '--target',
      '2%',
      '-t',
      'MARKET',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.Ok);
    // BUY: stoploss 2% above (1358.13), target 2% below (1304.87).
    expect(captured.body().condition.trigger_values).toEqual([1304.87, 1358.13]);
  });

  it('refuses a percentage with nothing to measure it from', async () => {
    await seedSession();

    const code = await invoke([...COPPER, '--stoploss', '2%', '--target', '2%', '-t', 'MARKET']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/measured from the last price/);
    expect(err).toMatch(/--last-price/);
  });
});

describe('gtt place: leg direction', () => {
  it('refuses a stoploss on the wrong side of a supplied last price', async () => {
    await seedSession();

    // SELL closes a long, so its stoploss belongs below 1500.
    const code = await invoke([
      ...INFY,
      '--last-price',
      '1500',
      '--stoploss',
      '1700',
      '--target',
      '1400',
      '-t',
      'MARKET',
    ]);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/stoploss must be below/);
    expect(err).toMatch(/Condition already met/);
  });

  it('skips the check when no reference price was given', async () => {
    await seedSession();
    interceptPlace();

    // Nonsense for a SELL, but with no price to judge against the CLI does not
    // guess — Kite evaluates against its own feed and rejects it there.
    const code = await invoke([...INFY, '--stoploss', '1700', '--target', '1400', '-t', 'MARKET', '--yes']);

    expect(code).toBe(ExitCode.Ok);
  });

  it('refuses two legs at the same price', async () => {
    await seedSession();

    const code = await invoke([...INFY, '--stoploss', '1500', '--target', '1500', '-t', 'MARKET']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/both ₹1,500\.00/);
  });
});

describe('gtt place: shape coherence', () => {
  it('refuses two --trigger values and names the OCO flags', async () => {
    await seedSession();

    const code = await invoke([...INFY, '--trigger', '1400', '--trigger', '1700', '-t', 'MARKET']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/not two --trigger values/);
    expect(err).toMatch(/--stoploss/);
  });

  it('refuses half an OCO', async () => {
    await seedSession();

    const code = await invoke([...INFY, '--stoploss', '1400', '-t', 'MARKET']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/only --target was given|needs both legs/);
  });

  it('refuses --trigger mixed with named legs', async () => {
    await seedSession();

    const code = await invoke([...INFY, '--trigger', '1400', '--stoploss', '1400', '--target', '1700']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/cannot be combined/);
  });

  it('refuses a shared --price on an OCO', async () => {
    await seedSession();

    const code = await invoke([...INFY, '--stoploss', '1400', '--target', '1700', '--price', '1500']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/--stoploss-price and --target-price/);
  });

  it('refuses a leg price on a single-leg GTT', async () => {
    await seedSession();

    const code = await invoke([...INFY, '--trigger', '1700', '--target-price', '1695']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/belong to an OCO/);
  });

  it('refuses a limit price alongside --order-type MARKET', async () => {
    await seedSession();

    const code = await invoke([...INFY, '--trigger', '1700', '--price', '1695', '-t', 'MARKET']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/cannot be used with --order-type MARKET/);
  });

  it('refuses a stop-loss order type a GTT cannot place', async () => {
    await seedSession();

    const code = await invoke([...INFY, '--trigger', '1700', '-t', 'SL-M']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/Unknown GTT order type/);
  });

  it('refuses a GTT with no trigger at all', async () => {
    await seedSession();

    const code = await invoke([...INFY, '-t', 'MARKET']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/needs a trigger/);
  });
});

describe('gtt place: product', () => {
  it('requires --product on a derivatives exchange', async () => {
    await seedSession();

    const code = await invoke([
      'gtt',
      'place',
      'MCX:COPPER26AUGFUT',
      '-s',
      'BUY',
      '-q',
      '1',
      '--stoploss',
      '1500',
      '--target',
      '900',
      '-t',
      'MARKET',
    ]);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/--product is required on MCX/);
    expect(err).toMatch(/equity-delivery product/);
  });

  it('defaults to CNC on an equity exchange', async () => {
    await seedSession();
    const captured = interceptPlace();

    const code = await invoke([...INFY, '--trigger', '1700', '--price', '1695', '--yes']);

    expect(code).toBe(ExitCode.Ok);
    expect(captured.body().orders[0]).toMatchObject({ product: 'CNC' });
  });
});
