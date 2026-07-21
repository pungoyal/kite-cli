import { registerSecret } from './redact.js';
import { encryptToFile, decryptFromFile, deleteCredentialFile } from './secretstore.js';
import { KiteCliError, ExitCode } from './errors.js';

/**
 * Layered credential storage.
 *
 *   1. Environment variables  — always win, never persisted. This is what makes
 *      CI, Docker, and headless servers work (cf. gh's GH_TOKEN escape hatch).
 *   2. OS keyring             — macOS Keychain / Windows Credential Manager /
 *                               Linux Secret Service, via @napi-rs/keyring.
 *   3. Encrypted file         — scrypt + AES-256-GCM at ~/.config/kite, 0600.
 *
 * keytar is deliberately not used: the repository was archived in 2022 and it
 * depends on prebuild-install, an install-time network fetch that npm v12 now
 * blocks by default.
 */

const SERVICE = 'kite-cli';

export type SecretName = 'api_secret' | 'access_token';

/** Env var that supplies each secret, bypassing all persistent storage. */
const ENV_VAR: Record<SecretName, string> = {
  api_secret: 'KITE_API_SECRET',
  access_token: 'KITE_ACCESS_TOKEN',
};

export type Backend = 'env' | 'keyring' | 'file';

export interface CredentialLookup {
  value: string;
  backend: Backend;
}

/**
 * `@napi-rs/keyring` is loaded lazily and defensively. On a headless Linux box
 * with no D-Bus the *module* imports fine but every operation throws, so we
 * probe on use rather than on import.
 */
let keyringModule: typeof import('@napi-rs/keyring') | null | undefined;

async function loadKeyring(): Promise<typeof import('@napi-rs/keyring') | null> {
  if (keyringModule !== undefined) return keyringModule;
  if (process.env['KITE_DISABLE_KEYRING'] === '1') {
    keyringModule = null;
    return null;
  }
  try {
    keyringModule = await import('@napi-rs/keyring');
  } catch {
    // No prebuilt binary for this platform, or the native module failed to
    // load. Fall through to the encrypted file.
    keyringModule = null;
  }
  return keyringModule;
}

async function keyringGet(account: string): Promise<string | null> {
  const mod = await loadKeyring();
  if (!mod) return null;
  try {
    const entry = new mod.Entry(SERVICE, account);
    // Note: @napi-rs/keyring returns null for a missing entry rather than
    // throwing (unlike keytar). A bare try/catch would treat "absent" as
    // success, so the null check is load-bearing.
    return entry.getPassword() ?? null;
  } catch {
    return null;
  }
}

async function keyringSet(account: string, value: string): Promise<boolean> {
  const mod = await loadKeyring();
  if (!mod) return false;
  try {
    new mod.Entry(SERVICE, account).setPassword(value);
    return true;
  } catch {
    return false;
  }
}

async function keyringDelete(account: string): Promise<void> {
  const mod = await loadKeyring();
  if (!mod) return;
  try {
    new mod.Entry(SERVICE, account).deletePassword();
  } catch {
    // Nothing stored, or the keyring is locked. Either way there is nothing
    // actionable for the caller.
  }
}

/** True when an OS keyring is present and usable on this machine. */
export async function keyringAvailable(): Promise<boolean> {
  const mod = await loadKeyring();
  if (!mod) return false;
  try {
    // A read against a name we never write. Succeeding (with null) proves the
    // backend is reachable; throwing proves it is not.
    new mod.Entry(SERVICE, '__probe__').getPassword();
    return true;
  } catch {
    return false;
  }
}

/**
 * Passphrase for the encrypted-file backend. Supplied via env, or prompted for
 * interactively by the caller (which passes it in here).
 */
function filePassphrase(): string | null {
  const value = process.env['KITE_CREDENTIALS_PASSPHRASE'];
  return value && value !== '' ? value : null;
}

/** Namespaced account key, so sandbox and production sessions coexist. */
function accountKey(name: SecretName, env: string): string {
  return env === 'production' ? name : `${env}:${name}`;
}

export interface CredentialStoreOptions {
  env: string;
  /** Passphrase for the file backend when the keyring is unavailable. */
  passphrase?: string | undefined;
}

/**
 * Read a secret, trying each backend in priority order.
 *
 * Every value returned is registered with the redactor, so it is scrubbed from
 * any subsequent log, error, or stack trace even if it reaches an unexpected
 * code path.
 */
export async function getSecret(
  name: SecretName,
  opts: CredentialStoreOptions,
): Promise<CredentialLookup | null> {
  const fromEnv = process.env[ENV_VAR[name]];
  if (fromEnv && fromEnv.trim() !== '') {
    registerSecret(fromEnv);
    return { value: fromEnv, backend: 'env' };
  }

  const account = accountKey(name, opts.env);

  const fromKeyring = await keyringGet(account);
  if (fromKeyring) {
    registerSecret(fromKeyring);
    return { value: fromKeyring, backend: 'keyring' };
  }

  const passphrase = opts.passphrase ?? filePassphrase();
  if (passphrase) {
    const bag = await decryptFromFile(passphrase);
    const value = bag?.[account];
    if (value) {
      registerSecret(value);
      return { value, backend: 'file' };
    }
  }

  return null;
}

export async function setSecret(
  name: SecretName,
  value: string,
  opts: CredentialStoreOptions,
): Promise<Backend> {
  registerSecret(value);
  const account = accountKey(name, opts.env);

  if (await keyringSet(account, value)) {
    return 'keyring';
  }

  const passphrase = opts.passphrase ?? filePassphrase();
  if (!passphrase) {
    throw new KiteCliError(
      'No OS keyring is available on this machine and no passphrase was supplied.',
      ExitCode.Failure,
      'Set KITE_CREDENTIALS_PASSPHRASE to enable the encrypted file store, or supply credentials via KITE_API_SECRET / KITE_ACCESS_TOKEN.',
    );
  }

  const existing = (await decryptFromFile(passphrase)) ?? {};
  existing[account] = value;
  await encryptToFile(existing, passphrase);
  return 'file';
}

export async function deleteSecret(name: SecretName, opts: CredentialStoreOptions): Promise<void> {
  const account = accountKey(name, opts.env);
  await keyringDelete(account);

  const passphrase = opts.passphrase ?? filePassphrase();
  if (passphrase) {
    const existing = await decryptFromFile(passphrase);
    if (existing && account in existing) {
      delete existing[account];
      if (Object.keys(existing).length === 0) {
        await deleteCredentialFile();
      } else {
        await encryptToFile(existing, passphrase);
      }
    }
  }
}

/** Remove every stored secret for an environment. Used by `kite logout --all`. */
export async function deleteAllSecrets(opts: CredentialStoreOptions): Promise<void> {
  await deleteSecret('access_token', opts);
  await deleteSecret('api_secret', opts);
}

/** True when secrets are being supplied entirely by the environment. */
export function usingEnvCredentials(): boolean {
  return Boolean(process.env[ENV_VAR.access_token] || process.env[ENV_VAR.api_secret]);
}
