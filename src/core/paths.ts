import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * XDG-compliant paths, with the usual macOS pragmatism: we use ~/.config rather
 * than ~/Library/Application Support, because CLI users expect their dotfiles
 * in one place and every comparable tool (gh, aws, stripe) does the same.
 */

function xdg(envVar: string, fallback: string): string {
  const value = process.env[envVar];
  if (value && value.trim() !== '') return value;
  return fallback;
}

export function configDir(): string {
  const override = process.env['KITE_CONFIG_DIR'];
  if (override && override.trim() !== '') return override;
  return join(xdg('XDG_CONFIG_HOME', join(homedir(), '.config')), 'kite');
}

export function cacheDir(): string {
  const override = process.env['KITE_CACHE_DIR'];
  if (override && override.trim() !== '') return override;
  return join(xdg('XDG_CACHE_HOME', join(homedir(), '.cache')), 'kite');
}

export function configFile(): string {
  return join(configDir(), 'config.json');
}

/** Non-secret session metadata (expiry, user id). The token itself is not here. */
export function sessionFile(): string {
  return join(configDir(), 'session.json');
}

/** Encrypted credential store, used only when the OS keyring is unavailable. */
export function credentialsFile(): string {
  return join(configDir(), 'credentials.enc');
}

/** Instrument master cache, refreshed daily. */
export function instrumentsCacheFile(env: string): string {
  return join(cacheDir(), `instruments.${env}.json`);
}

/** Create a directory with 0700 so secrets are not world-readable. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask, so set it explicitly. Not supported on
  // Windows, where ACLs already restrict the user profile directory.
  if (process.platform !== 'win32') {
    try {
      await chmod(dir, 0o700);
    } catch {
      // Directory may be owned by another user in a shared setup; the write
      // itself will fail later with a clearer error.
    }
  }
}
