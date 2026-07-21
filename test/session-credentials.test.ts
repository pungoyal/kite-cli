import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteAllSecrets, deleteSecret, getSecret, setSecret, usingEnvCredentials } from '../src/core/credentials.js';
import { configDir, credentialsFile, sessionFile } from '../src/core/paths.js';
import { loadSessionMeta, type SessionMeta, timeUntilExpiry } from '../src/core/session.js';

/**
 * Session-metadata parsing and the encrypted-file secret lifecycle.
 *
 * The keyring is disabled globally (setup.ts), so the secret tests exercise the
 * encrypted-file backend, which is the fallback path on headless machines. The
 * config dir is wiped per test and a passphrase is provided.
 */

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  await rm(configDir(), { recursive: true, force: true });
  process.env['KITE_CREDENTIALS_PASSPHRASE'] = 'test-passphrase';
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadSessionMeta tolerates a broken file', () => {
  it('returns null when the session file is absent', async () => {
    expect(await loadSessionMeta('default')).toBeNull();
  });

  it('returns null for unparseable JSON rather than throwing', async () => {
    await mkdir(configDir(), { recursive: true });
    await writeFile(sessionFile('default'), 'not json at all', 'utf8');
    expect(await loadSessionMeta('default')).toBeNull();
  });

  it('returns null for JSON that does not satisfy the schema', async () => {
    await mkdir(configDir(), { recursive: true });
    await writeFile(sessionFile('default'), JSON.stringify({ unexpected: true }), 'utf8');
    expect(await loadSessionMeta('default')).toBeNull();
  });
});

describe('timeUntilExpiry', () => {
  const at = (expiresAt: string): SessionMeta => ({
    userId: 'AB1234',
    env: 'production',
    apiKey: 'k',
    expiresAt,
    exchanges: [],
    products: [],
  });

  it('reports "expired" once the time has passed', () => {
    expect(timeUntilExpiry(at(new Date(Date.now() - 1000).toISOString()))).toBe('expired');
  });

  it('reports hours and minutes when more than an hour remains', () => {
    const soon = new Date(Date.now() + (2 * 3600 + 30 * 60) * 1000).toISOString();
    expect(timeUntilExpiry(at(soon))).toMatch(/^2h \d+m$/);
  });

  it('reports only minutes under an hour', () => {
    const soon = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    expect(timeUntilExpiry(at(soon))).toMatch(/^\d+m$/);
  });
});

describe('getSecret precedence', () => {
  it('returns the environment value first, tagged as the env backend', async () => {
    vi.stubEnv('KITE_ACCESS_TOKEN', 'testtoken123');
    // Env wins irrespective of the profile scope, and is never persisted.
    const found = await getSecret('access_token', { scope: 'profile:anyone:' });
    expect(found).toMatchObject({ value: 'testtoken123', backend: 'env' });
  });

  it('usingEnvCredentials reflects an ambient secret', async () => {
    expect(usingEnvCredentials()).toBe(false);
    vi.stubEnv('KITE_API_SECRET', 'testsecret1');
    expect(usingEnvCredentials()).toBe(true);
  });
});

describe('encrypted-file secret lifecycle', () => {
  it('round-trips a scoped secret', async () => {
    await setSecret('api_secret', 'shh', { scope: '' });
    expect((await getSecret('api_secret', { scope: '' }))?.value).toBe('shh');
  });

  it('keeps the file while another secret remains, and removes it when the last one goes', async () => {
    await setSecret('access_token', 'tok', { scope: '' });
    await setSecret('api_secret', 'sec', { scope: '' });
    expect(await fileExists(credentialsFile())).toBe(true);

    await deleteSecret('access_token', { scope: '' });
    expect(await fileExists(credentialsFile())).toBe(true);
    expect((await getSecret('api_secret', { scope: '' }))?.value).toBe('sec');

    await deleteSecret('api_secret', { scope: '' });
    // The file is removed once empty rather than left as an empty shell.
    expect(await fileExists(credentialsFile())).toBe(false);
  });

  it('deleteAllSecrets clears both the token and the secret', async () => {
    await setSecret('access_token', 'tok', { scope: '' });
    await setSecret('api_secret', 'sec', { scope: '' });

    await deleteAllSecrets({ scope: '' });
    expect(await getSecret('access_token', { scope: '' })).toBeNull();
    expect(await getSecret('api_secret', { scope: '' })).toBeNull();
  });
});
