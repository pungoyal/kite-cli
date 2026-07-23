import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDispatcher } from '../src/core/client.js';
import { defaultConfig, loadConfig, saveConfig } from '../src/core/config.js';
import { setSecret } from '../src/core/credentials.js';
import { ExitCode } from '../src/core/errors.js';
import { cacheDir, configDir } from '../src/core/paths.js';
import { loadSessionMeta, saveSessionMeta } from '../src/core/session.js';
import { run } from '../src/run.js';

/**
 * The `kite profiles` group, plus profile-aware `config` and `whoami`/`logout`,
 * driven through `run()` in-process.
 *
 * Assertions target stable contracts only — `run()`'s exit code, parsed --json
 * stdout, and the config read back through `loadConfig()` — never rendered table
 * layout or presentation strings, so wording tweaks do not break the suite.
 *
 * Most of these commands make no network call; a MockAgent with net-connect
 * disabled is installed anyway, so an accidental request fails loudly instead of
 * escaping to the real API.
 */

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
  await rm(cacheDir(), { recursive: true, force: true });
  delete process.env['KITE_PROFILE'];
});

afterEach(async () => {
  setDispatcher(undefined);
  await agent.close();
  vi.unstubAllEnvs();
});

function invoke(args: string[]) {
  return run({ argv: ['node', 'kite', ...args], streams: { stdout, stderr } });
}

/** The last JSON document written to stdout. */
function json<T = Record<string, unknown>>(): T {
  return JSON.parse(out) as T;
}

describe('profiles add', () => {
  it('registers a new profile', async () => {
    const code = await invoke(['profiles', 'add', 'spouse', '--api-key', 'spousekey']);
    expect(code).toBe(ExitCode.Ok);

    const config = await loadConfig();
    expect(config.profiles.spouse).toEqual({ apiKey: 'spousekey' });
  });

  it('stores a per-profile order-value cap as a trading override', async () => {
    const code = await invoke(['profiles', 'add', 'capped', '--max-order-value', '50000']);
    expect(code).toBe(ExitCode.Ok);

    const config = await loadConfig();
    expect(config.profiles.capped?.trading?.maxOrderValue).toBe(50000);
  });

  it('reports the addition as JSON', async () => {
    const code = await invoke(['--json', 'profiles', 'add', 'huf', '--api-key', 'hufkey']);
    expect(code).toBe(ExitCode.Ok);
    expect(json<{ added: string }>().added).toBe('huf');
  });

  it('refuses a reserved profile name', async () => {
    const code = await invoke(['profiles', 'add', 'default']);
    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/reserved/i);
  });

  it('refuses a duplicate profile', async () => {
    await invoke(['profiles', 'add', 'spouse', '--api-key', 'k']);
    const code = await invoke(['profiles', 'add', 'spouse', '--api-key', 'k']);
    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/already exists/i);
  });

  it('rejects a non-positive order-value cap', async () => {
    const code = await invoke(['profiles', 'add', 'spouse', '--max-order-value', '-5']);
    expect(code).toBe(ExitCode.Usage);
  });
});

describe('profiles remove', () => {
  it('refuses to remove a reserved profile', async () => {
    const code = await invoke(['profiles', 'remove', 'default', '--yes']);
    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/cannot be removed/i);
  });

  it('refuses to remove a profile that does not exist', async () => {
    const code = await invoke(['profiles', 'remove', 'ghost', '--yes']);
    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/no profile named/i);
  });

  it('requires confirmation and refuses in a non-interactive shell without --yes', async () => {
    await invoke(['profiles', 'add', 'spouse', '--api-key', 'k']);
    const code = await invoke(['profiles', 'remove', 'spouse']);
    expect(code).toBe(ExitCode.ConfirmationRequired);
    // The profile must survive a refused removal.
    expect((await loadConfig()).profiles.spouse).toBeDefined();
  });

  it('deletes the config entry and the session with --yes', async () => {
    await invoke(['profiles', 'add', 'spouse', '--api-key', 'k']);
    await saveSessionMeta({
      userId: 'CD5678',
      apiKey: 'k',
      profile: 'spouse',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      exchanges: [],
      products: [],
    });

    const code = await invoke(['profiles', 'remove', 'spouse', '--yes']);
    expect(code).toBe(ExitCode.Ok);

    expect((await loadConfig()).profiles.spouse).toBeUndefined();
    expect(await loadSessionMeta('spouse')).toBeNull();
  });

  it('clears a dangling default pointer when the default profile is removed', async () => {
    await invoke(['profiles', 'add', 'spouse', '--api-key', 'k']);
    await invoke(['profiles', 'use', 'spouse']);
    expect((await loadConfig()).defaultProfile).toBe('spouse');

    await invoke(['profiles', 'remove', 'spouse', '--yes']);
    expect((await loadConfig()).defaultProfile).toBeUndefined();
  });
});

describe('profiles use', () => {
  it('sets the default profile', async () => {
    await invoke(['profiles', 'add', 'spouse', '--api-key', 'k']);
    const code = await invoke(['profiles', 'use', 'spouse']);
    expect(code).toBe(ExitCode.Ok);
    expect((await loadConfig()).defaultProfile).toBe('spouse');
  });

  it('clears the pointer when set back to the reserved default', async () => {
    await invoke(['profiles', 'add', 'spouse', '--api-key', 'k']);
    await invoke(['profiles', 'use', 'spouse']);
    await invoke(['profiles', 'use', 'default']);
    expect((await loadConfig()).defaultProfile).toBeUndefined();
  });

  it('refuses an unknown profile', async () => {
    const code = await invoke(['profiles', 'use', 'ghost']);
    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/no profile named/i);
  });

  it('takes effect: a later bare command resolves to the new default', async () => {
    await invoke(['profiles', 'add', 'spouse', '--api-key', 'k']);
    await invoke(['profiles', 'use', 'spouse']);

    out = '';
    const code = await invoke(['--json', 'profiles', 'current']);
    expect(code).toBe(ExitCode.Ok);
    expect(json<{ profile: string }>().profile).toBe('spouse');
  });
});

describe('profiles current / list', () => {
  it('describes the resolved profile as JSON', async () => {
    const code = await invoke(['--json', 'profiles', 'current']);
    expect(code).toBe(ExitCode.Ok);
    expect(json()).toMatchObject({
      profile: 'default',
      logged_in: false,
      user_id: null,
    });
  });

  it('lists the reserved profile first, then configured ones', async () => {
    await invoke(['profiles', 'add', 'spouse', '--api-key', 'k']);
    out = '';

    const code = await invoke(['--json', 'profiles', 'list']);
    expect(code).toBe(ExitCode.Ok);
    const names = json<Array<{ profile: string }>>().map((row) => row.profile);
    expect(names[0]).toBe('default');
    expect(names).toContain('spouse');
  });
});

describe('config set/unset --profile', () => {
  it('routes a trading override into the named profile, not the global config', async () => {
    const code = await invoke(['--profile', 'spouse', 'config', 'set', 'trading.maxOrderValue', '50000']);
    expect(code).toBe(ExitCode.Ok);

    const config = await loadConfig();
    expect(config.profiles.spouse?.trading?.maxOrderValue).toBe(50000);
    // The global cap must be untouched.
    expect(config.trading.maxOrderValue).toBeUndefined();
  });

  it('unsets a per-profile override symmetrically', async () => {
    await invoke(['--profile', 'spouse', 'config', 'set', 'trading.maxOrderValue', '50000']);
    const code = await invoke(['--profile', 'spouse', 'config', 'unset', 'trading.maxOrderValue']);
    expect(code).toBe(ExitCode.Ok);
    expect((await loadConfig()).profiles.spouse?.trading?.maxOrderValue).toBeUndefined();
  });

  it('refuses a global-only setting when a profile is named', async () => {
    const code = await invoke(['--profile', 'spouse', 'config', 'set', 'output.color', 'never']);
    expect(code).toBe(ExitCode.Usage);
    expect(err).toMatch(/global setting/i);
  });
});

describe('whoami is profile-aware', () => {
  it('reports the resolved profile even when not logged in', async () => {
    const code = await invoke(['--json', 'whoami']);
    expect(code).toBe(ExitCode.Auth);
    expect(json()).toMatchObject({ logged_in: false, profile: 'default' });
  });

  it('enumerates every profile with --all, reserved first, without a network call', async () => {
    await invoke(['profiles', 'add', 'spouse', '--api-key', 'k']);
    out = '';

    const code = await invoke(['--json', 'whoami', '--all']);
    expect(code).toBe(ExitCode.Ok);
    const names = json<Array<{ profile: string }>>().map((row) => row.profile);
    expect(names[0]).toBe('default');
    expect(names).toContain('spouse');
  });
});

describe('logout clears the resolved profile', () => {
  // The single logout case: a stored token makes the session live, and logout
  // must clear local state even when Kite is unreachable (net-connect is off,
  // so the server-side invalidation attempt fails and is swallowed).
  it('removes the stored token and session for the default profile', async () => {
    process.env['KITE_CREDENTIALS_PASSPHRASE'] = 'test-passphrase';
    await saveSessionMeta({
      userId: 'AB1234',
      apiKey: 'legacykey',
      profile: 'default',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      exchanges: [],
      products: [],
    });
    await setSecret('access_token', 'live-token', { scope: '' });

    const code = await invoke(['logout']);
    expect(code).toBe(ExitCode.Ok);
    expect(await loadSessionMeta('default')).toBeNull();
  });
});

describe('whoami reflects the verified account when logged in', () => {
  // The 0.2.0 JSON contract: the Kite profile is nested under `account`, with
  // the active `profile` alongside it.
  it('nests the account object and names the profile', async () => {
    process.env['KITE_CREDENTIALS_PASSPHRASE'] = 'test-passphrase';
    await saveConfig({ ...defaultConfig(), apiKey: 'legacykey' });
    await saveSessionMeta({
      userId: 'AB1234',
      apiKey: 'legacykey',
      profile: 'default',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      exchanges: [],
      products: [],
    });
    await setSecret('access_token', 'live-token', { scope: '' });

    agent
      .get('https://api.kite.trade')
      .intercept({ path: '/user/profile', method: 'GET' })
      .reply(200, {
        status: 'success',
        data: {
          user_id: 'AB1234',
          user_name: 'Ada Lovelace',
          email: 'ada@example.com',
          broker: 'ZERODHA',
          exchanges: ['NSE'],
          products: ['CNC'],
        },
      });

    const code = await invoke(['--json', 'whoami']);
    expect(code).toBe(ExitCode.Ok);
    const doc = json<{ logged_in: boolean; profile: string; account: { user_id: string } }>();
    expect(doc.logged_in).toBe(true);
    expect(doc.profile).toBe('default');
    expect(doc.account.user_id).toBe('AB1234');
  });
});

describe('a tighter per-profile cap actually bites on a real order', () => {
  /**
   * The safety property no unit test can prove: the order path must read the
   * *overlaid* trading config (`ctx.config.trading`), not `loadConfig().trading`.
   * If it read the raw global, both cases below would place — so the contrast
   * (same 15,000 order allowed on default, refused on spouse) is what confirms
   * the per-profile override is enforced, not merely persisted.
   *
   * File-backend seeding is mandatory here: an ambient KITE_ACCESS_TOKEN plus an
   * explicit --profile would trip the conflict guard before the cap is reached.
   */
  async function seedTwoProfiles(): Promise<void> {
    process.env['KITE_CREDENTIALS_PASSPHRASE'] = 'test-passphrase';
    await saveConfig({
      ...defaultConfig(),
      apiKey: 'legacykey',
      trading: { ...defaultConfig().trading, maxOrderValue: 100_000 },
      profiles: { spouse: { apiKey: 'spousekey', trading: { maxOrderValue: 5_000 } } },
    });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await saveSessionMeta({
      userId: 'AB1234',
      apiKey: 'legacykey',
      profile: 'default',
      expiresAt: future,
      exchanges: [],
      products: [],
    });
    await saveSessionMeta({
      userId: 'CD5678',
      apiKey: 'spousekey',
      profile: 'spouse',
      expiresAt: future,
      exchanges: [],
      products: [],
    });
    await setSecret('access_token', 'default-token', { scope: '' });
    await setSecret('access_token', 'spouse-token', { scope: 'profile:spouse:' });
  }

  const placeArgs = ['orders', 'place', 'NSE:INFY', '-s', 'BUY', '-q', '10', '--type', 'LIMIT', '--price', '1500'];

  it('allows the 15,000 order on default, under the 100,000 global cap', async () => {
    await seedTwoProfiles();
    const pool = agent.get('https://api.kite.trade');
    pool.intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' }).reply(200, {
      status: 'success',
      data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
    });
    pool.intercept({ path: '/orders/regular', method: 'POST' }).reply(200, {
      status: 'success',
      data: { order_id: '901' },
    });

    const code = await invoke([...placeArgs, '--yes']);
    expect(code).toBe(ExitCode.Ok);
    expect(err).toMatch(/901/);
  });

  it('refuses the same 15,000 order on spouse, whose override caps it at 5,000', async () => {
    await seedTwoProfiles();
    agent
      .get('https://api.kite.trade')
      .intercept({ path: (p) => p.startsWith('/quote/ltp'), method: 'GET' })
      .reply(200, {
        status: 'success',
        data: { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } },
      });
    // No POST interceptor: reaching the network at all would fail the test.

    const code = await invoke(['--profile', 'spouse', ...placeArgs, '--yes']);
    expect(code).toBe(ExitCode.TradingDisabled);
    expect(err).toMatch(/exceeds/i);
  });
});
