import { mkdir, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDispatcher } from '../src/core/client.js';
import { ExitCode } from '../src/core/errors.js';
import { configDir, configFile, sessionFile } from '../src/core/paths.js';
import { run } from '../src/run.js';
import { generateOrderTag } from '../src/safety.js';

/**
 * End-to-end safety behaviour, driven through run() in-process.
 *
 * Running in-process rather than spawning matters: HTTP mocking cannot reach
 * into a child process, so this is the only layer where we can assert
 * "no request was made".
 */

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
      // Far future so it never reads as expired.
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
  vi.unstubAllEnvs();
});

function invoke(args: string[]) {
  return run({ argv: ['node', 'kite', ...args], streams: { stdout, stderr } });
}

describe('order tags', () => {
  it('fit inside Kite 20-character alphanumeric limit', () => {
    for (let i = 0; i < 200; i += 1) {
      const tag = generateOrderTag();
      expect(tag.length).toBeLessThanOrEqual(20);
      expect(tag).toMatch(/^[a-zA-Z0-9]+$/);
    }
  });

  it('are unique across rapid successive calls', () => {
    const tags = new Set(Array.from({ length: 500 }, () => generateOrderTag()));
    expect(tags.size).toBe(500);
  });
});

describe('confirmation in a non-interactive shell', () => {
  it('refuses to place an order without --yes and exits with a distinct code', async () => {
    await seedSession();
    // stdin is not a TTY under vitest, which is exactly the case being tested.
    agent
      .get('https://api.kite.trade')
      .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
      .reply(200, {
        status: 'success',
        data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
      });

    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '1',
      '--type',
      'LIMIT',
      '--price',
      '1500',
    ]);

    expect(code).toBe(ExitCode.ConfirmationRequired);
    // The error must name the flag that unblocks it.
    expect(err).toMatch(/--yes/);
  });
});

describe('--dry-run', () => {
  it('previews an order without sending it, and exits 0', async () => {
    await seedSession();
    agent
      .get('https://api.kite.trade')
      .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
      .reply(200, {
        status: 'success',
        data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
      });

    // No interceptor is registered for POST /orders/regular. With
    // disableNetConnect, any attempt to place would throw — so reaching exit 0
    // proves nothing was sent.
    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '10',
      '--type',
      'LIMIT',
      '--price',
      '1500',
      '--dry-run',
    ]);

    expect(code).toBe(ExitCode.Ok);
    expect(err).toMatch(/dry run/i);
    // The preview must show resolved facts, including computed value.
    expect(err).toMatch(/15,000/);
  });
});

describe('kill switch', () => {
  it('refuses every order command before touching the network', async () => {
    await seedSession({ trading: { enabled: false } });

    const code = await invoke(['orders', 'place', 'NSE:INFY', '-s', 'BUY', '-q', '1', '--yes']);

    expect(code).toBe(ExitCode.TradingDisabled);
    expect(err).toMatch(/kill switch/i);
  });

  it('blocks cancellation too, not just placement', async () => {
    await seedSession({ trading: { enabled: false } });
    const code = await invoke(['orders', 'cancel', '123456', '--yes']);
    expect(code).toBe(ExitCode.TradingDisabled);
  });
});

describe('order value cap', () => {
  it('refuses an order above the configured maximum', async () => {
    await seedSession({ trading: { enabled: true, maxOrderValue: 5000 } });
    agent
      .get('https://api.kite.trade')
      .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
      .reply(200, {
        status: 'success',
        data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
      });

    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '10',
      '--type',
      'LIMIT',
      '--price',
      '1500',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.TradingDisabled);
    expect(err).toMatch(/exceeds/i);
  });

  it('allows an order below the maximum', async () => {
    await seedSession({ trading: { enabled: true, maxOrderValue: 100_000 } });
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(200, {
      status: 'success',
      data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
    });
    pool
      .intercept({ path: '/orders/regular', method: 'POST' })
      .reply(200, { status: 'success', data: { order_id: '999' } });

    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '10',
      '--type',
      'LIMIT',
      '--price',
      '1500',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.Ok);
    expect(err).toMatch(/999/);
  });
});

describe('the value cap fails closed', () => {
  /**
   * The cap must not silently stop applying when the price lookup fails. The
   * quote endpoint is capped at 1 req/sec, so a 429 here is routine — and
   * treating "unknown value" as "within the cap" would disable the one guard
   * the user explicitly configured, exactly when the CLI is least sure what it
   * is about to do.
   */
  it('refuses a MARKET order when the price lookup fails and a cap is configured', async () => {
    await seedSession({ trading: { enabled: true, maxOrderValue: 50_000 } });
    agent
      .get('https://api.kite.trade')
      .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
      .reply(429, {
        status: 'error',
        message: 'Too many requests',
        error_type: 'NetworkException',
      });

    const code = await invoke(['orders', 'place', 'NSE:RELIANCE', '-s', 'BUY', '-q', '5000', '--yes']);

    expect(code).toBe(ExitCode.TradingDisabled);
    expect(err).toMatch(/cannot verify/i);
  });

  it('still allows an unpriced order when no cap is configured', async () => {
    await seedSession({ trading: { enabled: true } });
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(429, {
      status: 'error',
      message: 'Too many requests',
      error_type: 'NetworkException',
    });
    pool
      .intercept({ path: '/orders/regular', method: 'POST' })
      .reply(200, { status: 'success', data: { order_id: '555' } });

    const code = await invoke(['orders', 'place', 'NSE:INFY', '-s', 'BUY', '-q', '1', '--yes']);

    expect(code).toBe(ExitCode.Ok);
    // The user is still told the value could not be established.
    expect(err).toMatch(/could not fetch a price/i);
  });
});

describe('the value cap applies only to exposure-increasing actions', () => {
  /**
   * The cap limits how much exposure you may take on — not whether you may
   * unwind it. Blocking a cancel because the cap could not be evaluated would
   * leave a user unable to cancel their way out of a position, which is a
   * safety inversion.
   */
  it('does not block cancelling an order when a cap is configured', async () => {
    await seedSession({ trading: { enabled: true, maxOrderValue: 50_000 } });
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: '/orders', method: 'GET' }).reply(200, {
      status: 'success',
      data: [
        {
          order_id: '123',
          status: 'OPEN',
          variety: 'regular',
          tradingsymbol: 'INFY',
          exchange: 'NSE',
          quantity: 1,
        },
      ],
    });
    pool
      .intercept({ path: /\/orders\/regular\/.*/, method: 'DELETE' })
      .reply(200, { status: 'success', data: { order_id: '123' } });

    const code = await invoke(['orders', 'cancel', '123', '--yes']);
    expect(code).toBe(ExitCode.Ok);
  });

  it('does not block converting a position when a cap is configured', async () => {
    await seedSession({ trading: { enabled: true, maxOrderValue: 50_000 } });
    agent
      .get('https://api.kite.trade')
      .intercept({ path: '/portfolio/positions', method: 'PUT' })
      .reply(200, { status: 'success', data: true });

    const code = await invoke(['convert', 'NSE:INFY', '--quantity', '10', '--from', 'MIS', '--to', 'CNC', '--yes']);
    expect(code).toBe(ExitCode.Ok);
  });
});

describe('the value cap tracks the direction of a modify', () => {
  /**
   * Raising quantity or price increases exposure and is subject to the cap;
   * lowering it reduces exposure and must not be blocked — the same reasoning
   * that stops the cap from blocking a cancel.
   */
  it('does not block lowering the quantity even when the price cannot be fetched', async () => {
    await seedSession({ trading: { enabled: true, maxOrderValue: 50_000 } });
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: '/orders', method: 'GET' }).reply(200, {
      status: 'success',
      data: [
        {
          order_id: '123',
          status: 'OPEN',
          variety: 'regular',
          tradingsymbol: 'INFY',
          exchange: 'NSE',
          quantity: 100,
          price: 0,
          order_type: 'MARKET',
        },
      ],
    });
    // Unpriced order + failed quote lookup: value is unknown. Under the old
    // "every modify increases exposure" rule this fail-closed on the cap.
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(429, {
      status: 'error',
      message: 'Too many requests',
      error_type: 'NetworkException',
    });
    pool
      .intercept({ path: /\/orders\/regular\/.*/, method: 'PUT' })
      .reply(200, { status: 'success', data: { order_id: '123' } });

    const code = await invoke(['orders', 'modify', '123', '-q', '10', '--yes']);
    expect(code).toBe(ExitCode.Ok);
  });

  it('still blocks a modify that raises the quantity above the cap', async () => {
    await seedSession({ trading: { enabled: true, maxOrderValue: 50_000 } });
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: '/orders', method: 'GET' }).reply(200, {
      status: 'success',
      data: [
        {
          order_id: '123',
          status: 'OPEN',
          variety: 'regular',
          tradingsymbol: 'INFY',
          exchange: 'NSE',
          quantity: 10,
          price: 1500,
          order_type: 'LIMIT',
        },
      ],
    });

    const code = await invoke(['orders', 'modify', '123', '-q', '1000', '--yes']);
    expect(code).toBe(ExitCode.TradingDisabled);
    expect(err).toMatch(/exceeds/i);
  });
});

describe('cancel fails closed on an unreadable orderbook', () => {
  /**
   * Defaulting to variety 'regular' would cancel a CO or iceberg order at the
   * wrong endpoint, after showing a preview that read "unknown".
   */
  it('refuses rather than guessing the variety', async () => {
    await seedSession();
    agent.get('https://api.kite.trade').intercept({ path: '/orders', method: 'GET' }).reply(503, {
      status: 'error',
      message: 'OMS down',
      error_type: 'NetworkException',
    });

    const code = await invoke(['orders', 'cancel', '250720000123456', '--yes']);

    expect(code).toBe(ExitCode.Upstream);
    expect(err).toMatch(/variety.*unknown|unknown.*variety/i);
  });

  it('proceeds when the variety is given explicitly', async () => {
    await seedSession();
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: '/orders', method: 'GET' }).reply(503, {
      status: 'error',
      message: 'OMS down',
      error_type: 'NetworkException',
    });
    pool
      .intercept({ path: /\/orders\/co\/.*/, method: 'DELETE' })
      .reply(200, { status: 'success', data: { order_id: '250720000123456' } });

    const code = await invoke(['orders', 'cancel', '250720000123456', '--variety', 'co', '--yes']);
    expect(code).toBe(ExitCode.Ok);
  });

  it('reports a genuinely missing order distinctly from a failed lookup', async () => {
    await seedSession();
    agent
      .get('https://api.kite.trade')
      .intercept({ path: '/orders', method: 'GET' })
      .reply(200, { status: 'success', data: [] });

    const code = await invoke(['orders', 'cancel', '250720000123456', '--yes']);
    expect(code).toBe(ExitCode.Input);
    expect(err).toMatch(/not in today's orderbook/i);
  });
});

describe('input validation', () => {
  it('rejects a LIMIT order with no price', async () => {
    await seedSession();
    const code = await invoke(['orders', 'place', 'NSE:INFY', '-s', 'BUY', '-q', '1', '--type', 'LIMIT', '--yes']);
    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/--price is required/i);
  });

  it('rejects a MARKET order that also specifies a price', async () => {
    await seedSession();
    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '1',
      '--type',
      'MARKET',
      '--price',
      '100',
      '--yes',
    ]);
    expect(code).toBe(ExitCode.Usage);
  });

  it('rejects an SL order with no trigger price', async () => {
    await seedSession();
    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '1',
      '--type',
      'SL',
      '--price',
      '100',
      '--yes',
    ]);
    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/--trigger-price is required/i);
  });

  it('rejects a non-alphanumeric tag', async () => {
    await seedSession();
    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '1',
      '--type',
      'LIMIT',
      '--price',
      '100',
      '--tag',
      'has-a-dash',
      '--yes',
    ]);
    expect(code).toBe(ExitCode.Usage);
  });

  it('rejects a fractional quantity', async () => {
    await seedSession();
    const code = await invoke(['orders', 'place', 'NSE:INFY', '-s', 'BUY', '-q', '1.5', '--yes']);
    expect(code).toBe(ExitCode.Usage);
  });
});

describe('reconciliation after a failed placement', () => {
  /** Extract the tag the CLI actually sent from a captured form body. */
  function tagFrom(body: string): string {
    return new URLSearchParams(body).get('tag') ?? '';
  }

  it('checks the orderbook by tag instead of retrying, and reports the order landed', async () => {
    await seedSession();
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(200, {
      status: 'success',
      data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
    });

    // The placement fails at the network level — ambiguous: it may have executed.
    let sentTag = '';
    pool.intercept({ path: '/orders/regular', method: 'POST' }).replyWithError(new Error('socket hang up'));

    // Capture the tag from the preview instead of the body, since a network
    // error gives us no request callback. The tag is always previewed.
    pool.intercept({ path: '/orders', method: 'GET' }).reply(() => {
      sentTag = /Tag\s+(\S+)/.exec(err)?.[1] ?? '';
      return {
        statusCode: 200,
        data: {
          status: 'success',
          data: [{ order_id: '777', status: 'COMPLETE', tag: sentTag }],
        },
      };
    });

    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '1',
      '--type',
      'LIMIT',
      '--price',
      '1500',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.Upstream);
    expect(err).toMatch(/did reach kite/i);
    expect(err).toMatch(/777/);
    // The user must be told explicitly not to re-run.
    expect(err).toMatch(/not placed twice|do not re-run/i);
  });

  it('reports that no order was found (without promising it is safe to retry) when the tag is absent', async () => {
    await seedSession();
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(200, {
      status: 'success',
      data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
    });
    pool.intercept({ path: '/orders/regular', method: 'POST' }).replyWithError(new Error('socket hang up'));
    pool.intercept({ path: '/orders', method: 'GET' }).reply(200, { status: 'success', data: [] });

    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '1',
      '--type',
      'LIMIT',
      '--price',
      '1500',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.Upstream);
    // The tag was not found, but a not-yet-visible order is a real possibility,
    // so the CLI must not claim retrying is safe — it tells the user to verify.
    expect(err).toMatch(/no order was found/i);
    expect(err).toMatch(/before retrying/i);
    expect(err).not.toMatch(/safe to retry/i);
  });

  /**
   * A 5xx is just as ambiguous as a socket error: Kite's gateway can fail
   * after the OMS accepted the order. Without this, hintForApiError tells the
   * user to "retry shortly" and they buy twice.
   */
  it('reconciles on an HTTP 5xx rather than telling the user to retry', async () => {
    await seedSession();
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(200, {
      status: 'success',
      data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
    });

    let sentTag = '';
    pool.intercept({ path: '/orders/regular', method: 'POST' }).reply((opts) => {
      sentTag = tagFrom(String(opts.body));
      return {
        statusCode: 502,
        data: {
          status: 'error',
          message: 'Bad gateway',
          error_type: 'NetworkException',
        },
      };
    });

    pool.intercept({ path: '/orders', method: 'GET' }).reply(() => ({
      statusCode: 200,
      data: {
        status: 'success',
        data: [{ order_id: '888', status: 'COMPLETE', tag: sentTag }],
      },
    }));

    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '1',
      '--type',
      'LIMIT',
      '--price',
      '1500',
      '--yes',
    ]);

    expect(code).toBe(ExitCode.Upstream);
    expect(err).toMatch(/did reach kite/i);
    expect(err).toMatch(/888/);
    expect(err).not.toMatch(/retry shortly/i);
  });

  it('makes a user-supplied --tag unique, so it cannot match a stale order', async () => {
    await seedSession();
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(200, {
      status: 'success',
      data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
    });

    let sentTag = '';
    pool.intercept({ path: '/orders/regular', method: 'POST' }).reply((opts) => {
      sentTag = tagFrom(String(opts.body));
      return {
        statusCode: 200,
        data: { status: 'success', data: { order_id: '999' } },
      };
    });

    await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '1',
      '--type',
      'LIMIT',
      '--price',
      '1500',
      '--tag',
      'daily',
      '--yes',
    ]);

    // Keeps the user's label as a prefix for their own filtering...
    expect(sentTag.startsWith('daily')).toBe(true);
    // ...but is NOT the bare tag, or a repeat run would reconcile against the
    // previous order and report "already placed" for one that never was.
    expect(sentTag).not.toBe('daily');
    expect(sentTag.length).toBeLessThanOrEqual(20);
    expect(sentTag).toMatch(/^[a-zA-Z0-9]+$/);
  });
});

describe('--json mode', () => {
  it('writes machine-readable data to stdout and keeps notes off it', async () => {
    await seedSession();
    agent
      .get('https://api.kite.trade')
      .intercept({ path: '/portfolio/holdings', method: 'GET' })
      .reply(200, {
        status: 'success',
        data: [
          {
            tradingsymbol: 'INFY',
            exchange: 'NSE',
            quantity: 10,
            average_price: 1400,
            last_price: 1500,
            pnl: 1000,
          },
        ],
      });

    const code = await invoke(['holdings', '--json']);

    expect(code).toBe(ExitCode.Ok);
    const parsed = JSON.parse(out);
    expect(parsed[0].tradingsymbol).toBe('INFY');
    // stdout must be pure JSON — no table, no colour, no summary lines.
    expect(out).not.toMatch(/Invested/);
  });
});

describe('multi-account safety', () => {
  it('names the verified account in the order preview', async () => {
    await seedSession();
    agent
      .get('https://api.kite.trade')
      .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
      .reply(200, {
        status: 'success',
        data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
      });

    const code = await invoke([
      'orders',
      'place',
      'NSE:INFY',
      '-s',
      'BUY',
      '-q',
      '1',
      '--type',
      'LIMIT',
      '--price',
      '1500',
      '--dry-run',
    ]);

    expect(code).toBe(ExitCode.Ok);
    // The preview must carry the verified user id, not just a label — this is
    // the primary guard against placing an order on the wrong account.
    expect(err).toMatch(/Account/);
    expect(err).toMatch(/AB1234/);
  });

  it('fails closed when an explicit --profile collides with an ambient token', async () => {
    // seedSession sets KITE_ACCESS_TOKEN for the default account. Naming a
    // different profile explicitly must not silently reuse that token.
    await seedSession();

    const code = await invoke(['--profile', 'spouse', 'holdings']);

    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/KITE_ACCESS_TOKEN|KITE_API_SECRET/);
    expect(err).toMatch(/spouse/);
  });
});

describe('sandbox guard rails', () => {
  it('rejects MARKET orders, which the sandbox does not accept', async () => {
    await seedSession({ env: 'sandbox' });
    const code = await invoke(['--env', 'sandbox', 'orders', 'place', 'NSE:INFY', '-s', 'BUY', '-q', '1', '--yes']);
    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/sandbox does not accept MARKET/i);
  });
});
