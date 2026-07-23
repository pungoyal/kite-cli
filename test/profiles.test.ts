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
  // resolveProfile reads this directly; a developer shell must not leak in.
  delete process.env['KITE_PROFILE'];
});

afterEach(() => {
  delete process.env['KITE_PROFILE'];
});

describe('storage prefix (back-compat is the whole point)', () => {
  it('leaves the default profile unprefixed, as before', () => {
    expect(storagePrefixFor({ name: 'default' })).toBe('');
  });

  it('gives every other profile a collision-proof namespace', () => {
    expect(storagePrefixFor({ name: 'spouse' })).toBe('profile:spouse:');
  });
});

describe('profile resolution precedence', () => {
  it('falls back to the reserved default with no flags or config', () => {
    const p = resolveProfile({}, config());
    expect(p.name).toBe('default');
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
    const c = config({ defaultProfile: 'huf', profiles: { huf: { apiKey: 'k' } } });
    expect(resolveProfile({}, c).name).toBe('huf');
  });
});

describe('getProfile', () => {
  it('draws the default profile from the top-level config', () => {
    const p = getProfile(config({ apiKey: 'topkey' }), 'default');
    expect(p.apiKey).toBe('topkey');
  });

  it('synthesises an empty profile for an unknown name (so login can create it)', () => {
    const p = getProfile(config(), 'brandnew');
    expect(p).toMatchObject({ name: 'brandnew', apiKey: '' });
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
  it('lists the reserved profile first, then configured ones, without duplicates', () => {
    const c = config({ profiles: { huf: {}, spouse: {} } });
    expect(listProfileNames(c)).toEqual(['default', 'huf', 'spouse']);
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

    const defaultScope = storagePrefixFor({ name: 'default' });
    const spouseScope = storagePrefixFor({ name: 'spouse' });
    expect(defaultScope).not.toBe(spouseScope);

    await setSecret('access_token', 'token-default', { scope: defaultScope });
    await setSecret('access_token', 'token-spouse', { scope: spouseScope });

    expect((await getSecret('access_token', { scope: defaultScope }))?.value).toBe('token-default');
    expect((await getSecret('access_token', { scope: spouseScope }))?.value).toBe('token-spouse');
  });
});
