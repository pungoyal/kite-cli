import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { computePostbackChecksum } from '../src/core/auth.js';
import { setDispatcher } from '../src/core/client.js';
import { ExitCode } from '../src/core/errors.js';
import { configDir } from '../src/core/paths.js';
import { run } from '../src/run.js';

/**
 * `kite postback verify` end to end. It makes no network call — the only
 * thing under test is the offline checksum check against the stored (here,
 * env-supplied) API secret — see core/auth.ts and test/core.test.ts for the
 * checksum math itself. `disableNetConnect` with no interceptors registered
 * is the assertion that it stays that way: a stray request would throw.
 */

let agent: MockAgent;
let stdout: PassThrough;
let stderr: PassThrough;
let out: string;
let err: string;
let dir: string;

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
  process.env['KITE_API_KEY'] = 'testkey';
  process.env['KITE_API_SECRET'] = 'mysecret';

  dir = await mkdtemp(join(tmpdir(), 'kite-postback-'));
});

afterEach(async () => {
  setDispatcher(undefined);
  await agent.close();
  delete process.env['KITE_API_KEY'];
  delete process.env['KITE_API_SECRET'];
  await rm(dir, { recursive: true, force: true });
});

function invoke(args: string[]) {
  return run({ argv: ['node', 'kite', ...args], streams: { stdout, stderr } });
}

async function payloadFile(content: unknown): Promise<string> {
  const file = join(dir, 'payload.json');
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return file;
}

it('verifies a genuine payload and exits 0', async () => {
  const checksum = computePostbackChecksum('1', '2026-07-20 10:00:00', 'mysecret');
  const file = await payloadFile({ order_id: '1', order_timestamp: '2026-07-20 10:00:00', checksum });

  const code = await invoke(['postback', 'verify', file, '--json']);

  expect(code).toBe(ExitCode.Ok);
  expect(JSON.parse(out)).toEqual({ valid: true, order_id: '1', order_timestamp: '2026-07-20 10:00:00' });
});

it('flags a forged payload and exits with ExitCode.Input', async () => {
  const file = await payloadFile({ order_id: '1', order_timestamp: '2026-07-20 10:00:00', checksum: 'deadbeef' });

  const code = await invoke(['postback', 'verify', file]);

  expect(code).toBe(ExitCode.Input);
  expect(err).toMatch(/does not match/i);
});

it('reports the mismatch in --json mode too, without throwing', async () => {
  const file = await payloadFile({ order_id: '1', order_timestamp: '2026-07-20 10:00:00', checksum: 'deadbeef' });

  const code = await invoke(['postback', 'verify', file, '--json']);

  expect(code).toBe(ExitCode.Input);
  expect(JSON.parse(out)).toEqual({ valid: false, order_id: '1', order_timestamp: '2026-07-20 10:00:00' });
});

it('rejects a payload missing a required field', async () => {
  const file = await payloadFile({ order_id: '1', checksum: 'deadbeef' });

  const code = await invoke(['postback', 'verify', file]);

  expect(code).toBe(ExitCode.Usage);
  expect(err).toMatch(/order_timestamp/);
});

it('rejects invalid JSON', async () => {
  const file = await payloadFile('not json');

  const code = await invoke(['postback', 'verify', file]);

  expect(code).toBe(ExitCode.Usage);
  expect(err).toMatch(/could not parse/i);
});

it('never makes a network call — an unreadable file fails before any request', async () => {
  const code = await invoke(['postback', 'verify', join(dir, 'does-not-exist.json')]);
  expect(code).not.toBe(ExitCode.Ok);
});
