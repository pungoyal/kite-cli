import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, type GlobalOptions } from '../src/context.js';
import { type Config, defaultConfig, saveConfig } from '../src/core/config.js';
import { setSecret } from '../src/core/credentials.js';
import { ExitCode, KiteCliError } from '../src/core/errors.js';
import { configDir, sessionFile } from '../src/core/paths.js';
import { storagePrefixFor } from '../src/core/profiles.js';
import { clearSessionMeta, loadSessionMeta, type SessionMeta, saveSessionMeta } from '../src/core/session.js';

/**
 * Context assembly, exercised through the real `createContext` seam.
 *
 * `createContext` makes no network call — it only reads local config, session
 * metadata and stored secrets — so these run against the sandboxed temp config
 * dir with no HTTP mock. What they lock down is the safety-critical part of
 * account resolution: which stored token is trusted for which account, and the
 * fail-closed guard against an ambient token standing in for a named profile.
 *
 * Two seeding modes must never be mixed in one test (see each block):
 *   - stored-file: `setSecret(..., { scope })` with KITE_CREDENTIALS_PASSPHRASE
 *     and NO ambient token, so resolution reaches the env/apiKey/expiry checks.
 *   - ambient-env: KITE_ACCESS_TOKEN set, which short-circuits those checks and
 *     is only correct for the CI escape-hatch and the conflict-guard cases.
 */

const PASSPHRASE = 'test-passphrase';
const FUTURE = () => new Date(Date.now() + 86_400_000).toISOString();
const PAST = () => new Date(Date.now() - 3_600_000).toISOString();

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** Fresh capture streams so context warnings never hit the real terminal. */
function capture() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let err = '';
  stderr.on('data', (chunk) => (err += chunk));
  return { streams: { stdout, stderr }, err: () => err };
}

function context(options: GlobalOptions = {}, streams = capture()) {
  return createContext(options, signal(), streams.streams);
}

async function seedConfig(over: Partial<Config> = {}): Promise<void> {
  await saveConfig({ ...defaultConfig(), ...over });
}

async function seedSession(meta: Partial<SessionMeta> & Pick<SessionMeta, 'profile'>): Promise<void> {
  await saveSessionMeta({
    userId: 'AB1234',
    env: 'production',
    apiKey: 'legacykey',
    expiresAt: FUTURE(),
    exchanges: [],
    products: [],
    ...meta,
  });
}

beforeEach(async () => {
  await rm(configDir(), { recursive: true, force: true });
  // A developer shell must not leak selection state into resolution.
  delete process.env['KITE_PROFILE'];
  delete process.env['KITE_ENV'];
  // The encrypted-file backend (keyring is disabled globally in setup.ts).
  process.env['KITE_CREDENTIALS_PASSPHRASE'] = PASSPHRASE;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('trusting a stored access token (cross-account safety)', () => {
  // The headline promise of the profiles change: an existing single-account
  // install — top-level apiKey, session.json, an unprefixed stored token —
  // resolves to `default` and authenticates with zero migration.
  it('authenticates a legacy default install unchanged', async () => {
    await seedConfig({ apiKey: 'legacykey', env: 'production' });
    await seedSession({ profile: 'default', apiKey: 'legacykey', env: 'production' });
    await setSecret('access_token', 'legacy-token', { scope: '' });

    const ctx = await context();

    expect(ctx.profile.name).toBe('default');
    expect(ctx.credentialScope).toBe('');
    expect(ctx.client.hasSession()).toBe(true);
  });

  it('drops a token whose session belongs to a different environment', async () => {
    // Sending a sandbox token to production 403s; treat it as absent instead.
    await seedConfig({ apiKey: 'legacykey', env: 'production' });
    await seedSession({ profile: 'default', apiKey: 'legacykey', env: 'sandbox' });
    await setSecret('access_token', 'wrong-env-token', { scope: '' });

    expect((await context()).client.hasSession()).toBe(false);
  });

  it('drops a token whose session was issued for a different API key', async () => {
    // The app was re-keyed; the old token cannot be valid under the new key.
    await seedConfig({ apiKey: 'newkey', env: 'production' });
    await seedSession({ profile: 'default', apiKey: 'oldkey', env: 'production' });
    await setSecret('access_token', 'stale-key-token', { scope: '' });

    expect((await context()).client.hasSession()).toBe(false);
  });

  it('drops a token whose local expiry has already passed', async () => {
    await seedConfig({ apiKey: 'legacykey', env: 'production' });
    await seedSession({ profile: 'default', apiKey: 'legacykey', env: 'production', expiresAt: PAST() });
    await setSecret('access_token', 'expired-token', { scope: '' });

    expect((await context()).client.hasSession()).toBe(false);
  });
});

describe('per-profile credential isolation', () => {
  // The core reason profiles exist: two accounts logged in at once, each seeing
  // only its own token.
  it('reads a named profile token from its own namespace, and the default cannot see it', async () => {
    await seedConfig({ profiles: { spouse: { apiKey: 'spousekey', env: 'production' } } });
    await seedSession({ profile: 'spouse', apiKey: 'spousekey', env: 'production' });
    const spouseScope = storagePrefixFor({ name: 'spouse', env: 'production' });
    await setSecret('access_token', 'spouse-token', { scope: spouseScope });

    const spouse = await context({ profile: 'spouse' });
    expect(spouse.credentialScope).toBe('profile:spouse:');
    expect(spouse.client.hasSession()).toBe(true);

    // The default profile shares no secret with spouse.
    const fallback = await context();
    expect(fallback.credentialScope).toBe('');
    expect(fallback.client.hasSession()).toBe(false);
  });
});

describe('the ambient-token conflict guard (fails closed)', () => {
  it('refuses when a profile is named explicitly but an ambient token would override it', async () => {
    vi.stubEnv('KITE_ACCESS_TOKEN', 'testambienttoken');

    const err = await context({ profile: 'spouse' }).catch((e) => e);

    expect(err).toBeInstanceOf(KiteCliError);
    expect(err.exitCode).toBe(ExitCode.Usage);
    expect(err.message).toMatch(/spouse/);
    expect(err.message).toMatch(/KITE_ACCESS_TOKEN|KITE_API_SECRET/);
  });

  it('also fires when the profile is named through KITE_PROFILE, not just --profile', async () => {
    // Both entrances set explicit=true, so the invariant must hold for either.
    vi.stubEnv('KITE_PROFILE', 'spouse');
    vi.stubEnv('KITE_ACCESS_TOKEN', 'testambienttoken');

    const err = await context().catch((e) => e);

    expect(err).toBeInstanceOf(KiteCliError);
    expect(err.exitCode).toBe(ExitCode.Usage);
    expect(err.message).toMatch(/spouse/);
  });

  it('still lets an ambient token drive the default profile — the CI escape hatch', async () => {
    // The default profile is never "explicit", so the guard must not fire and
    // headless credential injection keeps working.
    vi.stubEnv('KITE_ACCESS_TOKEN', 'testambienttoken');

    const ctx = await context();

    expect(ctx.profile.explicit).toBe(false);
    expect(ctx.client.hasSession()).toBe(true);
    // With no session file, requireSession synthesises a minimal record.
    const session = ctx.requireSession();
    expect(session.userId).toBe('unknown');
    expect(session.profile).toBe('default');
  });
});

describe('resilience', () => {
  it('does not brick the CLI when the credential file cannot be decrypted', async () => {
    // A wrong passphrase / corrupt file must leave login and logout runnable —
    // the two commands the resulting warning tells the user to run — so context
    // construction has to swallow the read error rather than throw.
    await setSecret('access_token', 'sealed-token', { scope: '' });
    process.env['KITE_CREDENTIALS_PASSPHRASE'] = 'wrong-passphrase';

    const streams = capture();
    const ctx = await context({}, streams);

    expect(ctx.client.hasSession()).toBe(false);
    expect(streams.err()).toMatch(/re-authenticate|login/i);
  });
});

describe('requireApiSecret', () => {
  it('returns the public sandbox secret without touching storage', async () => {
    const ctx = await context({ env: 'sandbox' });
    expect(ctx.env).toBe('sandbox');
    await expect(ctx.requireApiSecret()).resolves.toBe('sandboxdemo-secret');
  });

  it('fails with the auth exit code when no secret is stored', async () => {
    await seedConfig({ apiKey: 'legacykey', env: 'production' });
    const ctx = await context();

    const err = await ctx.requireApiSecret().catch((e) => e);
    expect(err).toBeInstanceOf(KiteCliError);
    expect(err.exitCode).toBe(ExitCode.Auth);
  });
});

describe('per-profile session files', () => {
  // Distinct filenames are what let several accounts hold a live session at
  // once; the default keeps the historical path so nothing migrates.
  it('keeps the default at session.json and namespaces every other profile', () => {
    expect(sessionFile('default').endsWith('session.json')).toBe(true);
    expect(sessionFile('spouse').endsWith('session.spouse.json')).toBe(true);
    expect(sessionFile('default')).not.toBe(sessionFile('spouse'));
  });

  it('round-trips a named profile session without disturbing the default', async () => {
    await seedSession({ profile: 'default', userId: 'AB1234' });
    await seedSession({ profile: 'spouse', userId: 'CD5678', apiKey: 'spousekey' });

    expect((await loadSessionMeta('spouse'))?.userId).toBe('CD5678');

    await clearSessionMeta('spouse');
    expect(await loadSessionMeta('spouse')).toBeNull();
    // Clearing one profile must not remove another's session.
    expect((await loadSessionMeta('default'))?.userId).toBe('AB1234');
  });
});
