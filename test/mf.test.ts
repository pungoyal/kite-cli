import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setDispatcher } from '../src/core/client.js';
import { ExitCode } from '../src/core/errors.js';
import { cacheDir, configDir } from '../src/core/paths.js';
import { run } from '../src/run.js';

/**
 * Mutual fund read commands, driven through run() against a mocked API. Same
 * shape as commands-read.test.ts: assert exit code and the parsed --json
 * document, never table layout.
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
  // instruments search/refresh cache the MF dump on disk on the same daily
  // cadence as the equity one — clear it so each test hits the mocked network.
  await rm(cacheDir(), { recursive: true, force: true });
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

it('mf holdings: renders the holdings array as JSON', async () => {
  pool()
    .intercept({ path: '/mf/holdings', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [
        {
          folio: '123/456',
          fund: 'Parag Parikh Flexi Cap',
          tradingsymbol: 'INF879O01027',
          average_price: 50,
          last_price: 75,
          pnl: 2500,
          quantity: 100,
        },
      ],
    });

  const code = await invoke(['mf', 'holdings', '--json']);
  expect(code).toBe(ExitCode.Ok);
  const doc = JSON.parse(out);
  expect(doc[0].fund).toBe('Parag Parikh Flexi Cap');
  expect(doc[0].quantity).toBe(100);
});

it('mf orders: renders recent orders as JSON', async () => {
  pool()
    .intercept({ path: '/mf/orders', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [
        {
          order_id: 'mf-1',
          fund: 'Parag Parikh Flexi Cap',
          tradingsymbol: 'INF879O01027',
          transaction_type: 'BUY',
          status: 'COMPLETE',
          quantity: 100,
          amount: 5000,
          order_timestamp: '2026-07-20 10:00:00',
        },
      ],
    });

  const code = await invoke(['mf', 'orders', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out)[0].order_id).toBe('mf-1');
});

it('mf sips: renders SIPs as JSON', async () => {
  pool()
    .intercept({ path: '/mf/sips', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: [
        {
          sip_id: 'sip-1',
          fund: 'Parag Parikh Flexi Cap',
          tradingsymbol: 'INF879O01027',
          status: 'ACTIVE',
          instalment_amount: 5000,
          instalments: 12,
          frequency: 'monthly',
          next_instalment: '2026-08-01',
        },
      ],
    });

  const code = await invoke(['mf', 'sips', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out)[0].sip_id).toBe('sip-1');
});

it('mf holdings: renders an empty holdings list', async () => {
  pool().intercept({ path: '/mf/holdings', method: 'GET' }).reply(200, { status: 'success', data: [] });

  const code = await invoke(['mf', 'holdings', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out)).toEqual([]);
});

it('mf orders get: fetches a single order regardless of its age', async () => {
  pool()
    .intercept({ path: '/mf/orders/mf-999', method: 'GET' })
    .reply(200, {
      status: 'success',
      data: {
        order_id: 'mf-999',
        fund: 'Parag Parikh Flexi Cap',
        tradingsymbol: 'INF879O01027',
        transaction_type: 'BUY',
        status: 'COMPLETE',
        quantity: 100,
        amount: 5000,
        order_timestamp: '2025-01-15 10:00:00',
      },
    });

  const code = await invoke(['mf', 'orders', 'get', 'mf-999', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out).order_id).toBe('mf-999');
});

const MF_INSTRUMENTS_CSV = [
  'tradingsymbol,amc,name,purchase_allowed,redemption_allowed,minimum_purchase_amount,purchase_amount_multiplier,minimum_additional_purchase_amount,minimum_redemption_quantity,redemption_quantity_multiplier,dividend_type,scheme_type,plan,settlement_type,last_price,last_price_date',
  'INF879O01027,ParagParikhMutualFund_MF,Parag Parikh Flexi Cap Fund,1,1,1000.0,1.0,500.0,0.001,0.001,growth,equity,direct,T3,75.5,2026-07-20',
  'INF209K01157,BirlaSunLifeMutualFund_MF,Aditya Birla Sun Life Advantage Fund,1,1,1000.0,1.0,1000.0,0.001,0.001,payout,equity,regular,T3,106.8,2017-11-23',
  '',
].join('\n');

it('mf instruments search: downloads the CSV dump and matches by fund name', async () => {
  pool().intercept({ path: '/mf/instruments', method: 'GET' }).reply(200, MF_INSTRUMENTS_CSV);

  const code = await invoke(['mf', 'instruments', 'search', 'parag parikh', '--json']);
  expect(code).toBe(ExitCode.Ok);
  const results = JSON.parse(out);
  expect(results).toHaveLength(1);
  expect(results[0].tradingsymbol).toBe('INF879O01027');
});

it('mf instruments refresh: reports the cached count', async () => {
  pool().intercept({ path: '/mf/instruments', method: 'GET' }).reply(200, MF_INSTRUMENTS_CSV);

  const code = await invoke(['mf', 'instruments', 'refresh', '--json']);
  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out)).toEqual({ refreshed: true, count: 2 });
});
