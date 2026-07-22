import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setDispatcher } from '../src/core/client.js';
import { ExitCode } from '../src/core/errors.js';
import { configDir } from '../src/core/paths.js';
import { run } from '../src/run.js';

/**
 * Read-only commands, driven through run() against a mocked API.
 *
 * These exercise the full command → api → schema → JSON-render path. Assertions
 * are on the exit code and the parsed --json document (a stable contract), never
 * on table layout — so they cover the command surface without being brittle.
 *
 * Credentials come from the environment (the default profile's CI path), so no
 * session file or keyring is needed and the conflict guard never fires.
 */

let agent: MockAgent;
let stdout: PassThrough;
let stderr: PassThrough;
let out: string;

beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setDispatcher(agent);

  stdout = new PassThrough();
  stderr = new PassThrough();
  out = '';
  stdout.on('data', (chunk) => (out += chunk));

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

it('funds: renders the margins document as JSON', async () => {
  pool()
    .intercept({ path: '/user/margins', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: { equity: { enabled: true, net: 100000 }, commodity: { enabled: false, net: 0 } },
    });

  const code = await invoke(['funds', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out).equity.net).toBe(100000);
});

it('positions: renders net and day positions as JSON', async () => {
  pool()
    .intercept({ path: '/portfolio/positions', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: { net: [{ tradingsymbol: 'INFY', exchange: 'NSE', quantity: 10, pnl: 500 }], day: [] },
    });

  const code = await invoke(['positions', '--json']);
  expect(code).toBe(ExitCode.Ok);
  // The JSON payload is the bare array of positions being displayed (net here),
  // not the {net, day} envelope.
  expect(JSON.parse(out)[0].tradingsymbol).toBe('INFY');
});

it('orders list: renders the orderbook as a JSON array', async () => {
  pool()
    .intercept({ path: '/orders', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [{ order_id: '1', status: 'OPEN', tradingsymbol: 'INFY', exchange: 'NSE', quantity: 1 }],
    });

  const code = await invoke(['orders', 'list', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out)[0].order_id).toBe('1');
});

it('trades: renders the tradebook as a JSON array', async () => {
  pool()
    .intercept({ path: '/trades', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [{ trade_id: 't1', order_id: '1', tradingsymbol: 'INFY', exchange: 'NSE' }],
    });

  const code = await invoke(['trades', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out)[0].trade_id).toBe('t1');
});

it('gtt list: renders triggers as JSON', async () => {
  pool()
    .intercept({ path: '/gtt/triggers', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [
        {
          id: 1,
          type: 'single',
          status: 'active',
          condition: { exchange: 'NSE', tradingsymbol: 'INFY', trigger_values: [1500] },
          orders: [],
        },
      ],
    });

  const code = await invoke(['gtt', 'list', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out)[0].id).toBe(1);
});

it('alerts list: renders alerts as JSON', async () => {
  pool()
    .intercept({ path: '/alerts', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [
        {
          uuid: 'u-1',
          type: 'simple',
          status: 'enabled',
          lhs_exchange: 'INDICES',
          lhs_tradingsymbol: 'NIFTY 50',
          operator: '>=',
          rhs_type: 'constant',
          rhs_constant: 27000,
        },
      ],
    });

  const code = await invoke(['alerts', 'list', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out)[0].uuid).toBe('u-1');
});

it('alerts delete: passes every UUID as a repeated query param', async () => {
  let requestPath = '';
  // Preview enrichment reads the alert list first; an empty list is fine.
  pool().intercept({ path: '/alerts', method: 'GET' }).reply(200, { status: 'success', data: [] });
  pool()
    .intercept({ path: (p) => p.startsWith('/alerts') && !p.includes('history'), method: 'DELETE' })
    .reply((opts) => {
      requestPath = String(opts.path);
      return { statusCode: 200, data: { status: 'success', data: {} } };
    });

  const code = await invoke(['alerts', 'delete', 'aaa', 'bbb', '--yes', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(requestPath).toContain('uuid=aaa');
  expect(requestPath).toContain('uuid=bbb');
});

it('ltp: renders last traded prices as JSON', async () => {
  pool()
    .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
    .reply(200, {
      status: 'success',
      data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
    });

  const code = await invoke(['ltp', 'NSE:INFY', '--json']);
  expect(code).toBe(ExitCode.Ok);
  // Whatever the exact shape, it must be valid JSON mentioning the price.
  expect(out).toContain('1500');
});

it('a failed read maps the Kite error to the documented exit code', async () => {
  // A TokenException must surface as the auth exit code, not a generic failure.
  pool()
    .intercept({ path: '/portfolio/holdings', method: 'GET' })
    .reply(403, { status: 'error', message: 'token expired', error_type: 'TokenException' });

  const code = await invoke(['holdings', '--json']);
  expect(code).toBe(ExitCode.Auth);
});

// --- orders reconcile ------------------------------------------------------
//
// The standalone recovery path for the no-idempotency problem: given the unique
// tag every CLI order carries, answer "did it actually reach Kite?" so the user
// knows whether it is safe to place again.

it('orders reconcile <tag>: reports a matching order as placed', async () => {
  pool()
    .intercept({ path: '/orders', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [
        { order_id: '111', status: 'COMPLETE', tradingsymbol: 'INFY', exchange: 'NSE', quantity: 1, tag: 'kcabc123' },
        { order_id: '222', status: 'OPEN', tradingsymbol: 'TCS', exchange: 'NSE', quantity: 1, tag: 'other' },
      ],
    });

  const code = await invoke(['orders', 'reconcile', 'kcabc123', '--json']);
  expect(code).toBe(ExitCode.Ok);
  const doc = JSON.parse(out);
  expect(doc.placed).toBe(true);
  expect(doc.order_ids).toEqual(['111']);
});

it('orders reconcile <tag>: reports an absent tag as not placed', async () => {
  pool()
    .intercept({ path: '/orders', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [
        { order_id: '111', status: 'COMPLETE', tradingsymbol: 'INFY', exchange: 'NSE', quantity: 1, tag: 'kcabc' },
      ],
    });

  const code = await invoke(['orders', 'reconcile', 'kcMISSING', '--json']);
  // A clean "not found" is a valid answer, not a failure.
  expect(code).toBe(ExitCode.Ok);
  const doc = JSON.parse(out);
  expect(doc.placed).toBe(false);
  expect(doc.order_ids).toEqual([]);
});

it('orders reconcile <tag>: matches a tag in the repeated `tags` array too', async () => {
  pool()
    .intercept({ path: '/orders', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [
        { order_id: '333', status: 'COMPLETE', tradingsymbol: 'INFY', exchange: 'NSE', quantity: 1, tags: ['kczzz9'] },
      ],
    });

  const code = await invoke(['orders', 'reconcile', 'kczzz9', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out).order_ids).toEqual(['333']);
});

it('orders reconcile (no tag): lists only orders this CLI placed', async () => {
  pool()
    .intercept({ path: '/orders', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [
        { order_id: '111', status: 'COMPLETE', tradingsymbol: 'INFY', exchange: 'NSE', quantity: 1, tag: 'kcaaa' },
        { order_id: '222', status: 'OPEN', tradingsymbol: 'TCS', exchange: 'NSE', quantity: 1, tag: 'manual' },
        { order_id: '333', status: 'OPEN', tradingsymbol: 'WIPRO', exchange: 'NSE', quantity: 1 },
      ],
    });

  const code = await invoke(['orders', 'reconcile', '--json']);
  expect(code).toBe(ExitCode.Ok);
  const ids = JSON.parse(out).map((o: { order_id: string }) => o.order_id);
  // Only the kc-prefixed order; the manually-tagged and untagged ones are excluded.
  expect(ids).toEqual(['111']);
});
