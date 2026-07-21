import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Config, defaultConfig } from '../src/core/config.js';
import { getSecret, setSecret } from '../src/core/credentials.js';
import {
  assertValidProfileName,
  getProfile,
  listProfileNames,
  resolveProfile,
  resolveTradingConfig,
  storagePrefixFor,
} from '../src/core/profiles.js';

/**
 * Profile resolution is pure and filesystem-free, so it is unit-tested directly.
 * The load-bearing property is back-compat: the reserved profiles must map onto
 * the exact secret-storage keys the single-account CLI has always written.
 */

function config(over: Partial<Config> = {}): Config {
  return { ...defaultConfig(), ...over };
}

beforeEach(() => {
  // resolveProfile reads these directly; a developer shell must not leak in.
  delete process.env['KITE_PROFILE'];
  delete process.env['KITE_ENV'];
});

afterEach(() => {
  delete process.env['KITE_PROFILE'];
  delete process.env['KITE_ENV'];
});

describe('storage prefix (back-compat is the whole point)', () => {
  it('leaves the default production profile unprefixed, as before', () => {
    expect(storagePrefixFor({ name: 'default', env: 'production' })).toBe('');
  });

  it('keeps the sandbox namespace the single-account CLI used', () => {
    expect(storagePrefixFor({ name: 'sandbox', env: 'sandbox' })).toBe('sandbox:');
  });

  it('maps a default profile pinned to sandbox onto the same sandbox namespace', () => {
    // A user whose config.env is sandbox kept their secrets under `sandbox:`.
    expect(storagePrefixFor({ name: 'default', env: 'sandbox' })).toBe('sandbox:');
  });

  it('gives every other profile a collision-proof namespace', () => {
    expect(storagePrefixFor({ name: 'spouse', env: 'production' })).toBe('profile:spouse:');
  });
});

describe('profile resolution precedence', () => {
  it('falls back to the reserved default with no flags or config', () => {
    const p = resolveProfile({}, config());
    expect(p.name).toBe('default');
    expect(p.env).toBe('production');
    expect(p.explicit).toBe(false);
  });

  it('treats --env sandbox as an alias for the sandbox profile, not an explicit account', () => {
    const p = resolveProfile({ envFlag: 'sandbox' }, config());
    expect(p.name).toBe('sandbox');
    expect(p.env).toBe('sandbox');
    // Not explicit: the env-var guard must not fire on the legacy alias.
    expect(p.explicit).toBe(false);
  });

  it('marks --profile as an explicit account choice', () => {
    const p = resolveProfile({ profileFlag: 'spouse' }, config());
    expect(p.name).toBe('spouse');
    expect(p.explicit).toBe(true);
  });

  it('honours KITE_PROFILE, and lets --profile win over it', () => {
    process.env['KITE_PROFILE'] = 'fromenv';
    expect(resolveProfile({}, config()).name).toBe('fromenv');
    expect(resolveProfile({ profileFlag: 'fromflag' }, config()).name).toBe('fromflag');
  });

  it('uses the configured default profile when nothing is named', () => {
    const c = config({ defaultProfile: 'huf', profiles: { huf: { apiKey: 'k', env: 'production' } } });
    expect(resolveProfile({}, c).name).toBe('huf');
  });

  it('lets an explicit --env override the resolved profile environment', () => {
    // config.env pins the default profile to sandbox; --env production forces it back.
    const c = config({ env: 'sandbox' });
    expect(resolveProfile({}, c).env).toBe('sandbox');
    expect(resolveProfile({ envFlag: 'production' }, c).env).toBe('production');
  });

  it('rejects an unknown --env', () => {
    expect(() => resolveProfile({ envFlag: 'staging' }, config())).toThrow(/unknown environment/i);
  });

  it('uses the public sandbox key for a default profile pinned to sandbox via config', () => {
    // The persisted-sandbox path (config.env = sandbox, no --env flag): the key
    // must be the demo key, not the empty/production config apiKey.
    const p = resolveProfile({}, config({ env: 'sandbox', apiKey: 'prodkey' }));
    expect(p.name).toBe('default');
    expect(p.env).toBe('sandbox');
    expect(p.apiKey).toBe('sandboxdemo');
  });
});

describe('getProfile', () => {
  it('returns the public sandbox credentials for the sandbox profile', () => {
    const p = getProfile(config(), 'sandbox');
    expect(p.env).toBe('sandbox');
    expect(p.apiKey).toBe('sandboxdemo');
  });

  it('draws the default profile from the top-level config', () => {
    const p = getProfile(config({ apiKey: 'topkey', env: 'production' }), 'default');
    expect(p.apiKey).toBe('topkey');
  });

  it('synthesises an empty production profile for an unknown name (so login can create it)', () => {
    const p = getProfile(config(), 'brandnew');
    expect(p).toMatchObject({ name: 'brandnew', apiKey: '', env: 'production' });
  });
});

describe('per-profile trading overrides (fail-closed inheritance)', () => {
  it('inherits the global cap when the profile sets none', () => {
    const c = config({ trading: { ...defaultConfig().trading, maxOrderValue: 50_000 } });
    const profile = getProfile(c, 'default'); // no overrides
    expect(resolveTradingConfig(c, profile).maxOrderValue).toBe(50_000);
  });

  it('lets a profile tighten the cap', () => {
    const c = config({
      trading: { ...defaultConfig().trading, maxOrderValue: 50_000 },
      profiles: { spouse: { trading: { maxOrderValue: 10_000 } } },
    });
    const profile = resolveProfile({ profileFlag: 'spouse' }, c);
    expect(resolveTradingConfig(c, profile).maxOrderValue).toBe(10_000);
  });

  it('does not let an omitted override widen anything else', () => {
    const c = config({
      trading: { ...defaultConfig().trading, enabled: false },
      profiles: { spouse: { trading: { maxOrderValue: 10_000 } } },
    });
    const profile = resolveProfile({ profileFlag: 'spouse' }, c);
    // The kill switch was off globally; the profile only set a cap, so it stays off.
    expect(resolveTradingConfig(c, profile).enabled).toBe(false);
  });
});

describe('profile bookkeeping', () => {
  it('lists reserved profiles first, then configured ones, without duplicates', () => {
    const c = config({ profiles: { huf: {}, spouse: {} } });
    expect(listProfileNames(c)).toEqual(['default', 'sandbox', 'huf', 'spouse']);
  });

  it('rejects names that could escape a filename', () => {
    expect(() => assertValidProfileName('../evil')).toThrow(/invalid profile name/i);
    expect(() => assertValidProfileName('a b')).toThrow();
    expect(() => assertValidProfileName('ok_name-1')).not.toThrow();
  });
});

describe('scoped credential storage keeps profiles isolated', () => {
  // The core promise of the feature: two accounts can be logged in at once
  // without their tokens colliding. The global test setup disables the keyring,
  // so this exercises the encrypted-file backend.
  it('stores and reads each profile token under its own namespace', async () => {
    process.env['KITE_CREDENTIALS_PASSPHRASE'] = 'test-passphrase';

    const defaultScope = storagePrefixFor({ name: 'default', env: 'production' });
    const spouseScope = storagePrefixFor({ name: 'spouse', env: 'production' });
    expect(defaultScope).not.toBe(spouseScope);

    await setSecret('access_token', 'token-default', { scope: defaultScope });
    await setSecret('access_token', 'token-spouse', { scope: spouseScope });

    expect((await getSecret('access_token', { scope: defaultScope }))?.value).toBe('token-default');
    expect((await getSecret('access_token', { scope: spouseScope }))?.value).toBe('token-spouse');
  });
});
