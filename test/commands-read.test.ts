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
