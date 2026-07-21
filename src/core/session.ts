import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { configDir, ensurePrivateDir, sessionFile } from './paths.js';

/**
 * Non-secret session metadata.
 *
 * The access token itself lives in the OS keyring; only its expiry and the
 * identity it belongs to are stored here. That split lets `kite whoami` show
 * who you are and when your session dies without unlocking the keyring, and
 * lets `kite logout` drop the token without touching the API secret.
 */

export const SessionMetaSchema = z.object({
  userId: z.string(),
  userName: z.string().optional(),
  broker: z.string().optional(),
  env: z.string(),
  apiKey: z.string(),
  /** The profile this session belongs to. Optional so pre-profile files parse. */
  profile: z.string().optional(),
  /** ISO 8601. Kite invalidates all tokens at 06:00 IST daily. */
  expiresAt: z.string(),
  loginTime: z.string().optional(),
  exchanges: z.array(z.string()).default([]),
  products: z.array(z.string()).default([]),
});

export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export async function loadSessionMeta(profile = 'default'): Promise<SessionMeta | null> {
  let raw: string;
  try {
    raw = await readFile(sessionFile(profile), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const result = SessionMetaSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function saveSessionMeta(meta: SessionMeta): Promise<void> {
  await ensurePrivateDir(configDir());
  const path = sessionFile(meta.profile ?? 'default');
  await writeFile(path, `${JSON.stringify(meta, null, 2)}\n`, {
    mode: 0o600,
    encoding: 'utf8',
  });
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
  }
}

export async function clearSessionMeta(profile = 'default'): Promise<void> {
  try {
    await unlink(sessionFile(profile));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Kite access tokens expire at 06:00 IST the following day — a regulatory
 * requirement, not a configurable session length.
 *
 * This is a floor, not a guarantee: a master logout from Kite web invalidates
 * the token immediately, and there is no way to detect that except by getting a
 * 403. Callers must treat TokenException as authoritative regardless of what
 * this says.
 */
export function nextTokenExpiry(now: Date = new Date()): Date {
  // Work out "now" in IST, decide whether 6 AM IST has already passed today,
  // then build the corresponding UTC instant.
  const istOffsetMs = 5.5 * 3600 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);

  const year = istNow.getUTCFullYear();
  const month = istNow.getUTCMonth();
  const day = istNow.getUTCDate();
  const hour = istNow.getUTCHours();

  // 06:00 IST today, expressed as a UTC instant.
  let expiryUtcMs = Date.UTC(year, month, day, 6, 0, 0) - istOffsetMs;
  if (hour >= 6) {
    // Already past 6 AM IST, so the token dies at 6 AM IST tomorrow.
    expiryUtcMs += 24 * 3600 * 1000;
  }
  return new Date(expiryUtcMs);
}

export function isExpired(meta: SessionMeta, now: Date = new Date()): boolean {
  const expiry = Date.parse(meta.expiresAt);
  if (Number.isNaN(expiry)) return true;
  return now.getTime() >= expiry;
}

/** Human-readable time remaining, e.g. "4h 12m". */
export function timeUntilExpiry(meta: SessionMeta, now: Date = new Date()): string {
  const remaining = Date.parse(meta.expiresAt) - now.getTime();
  if (Number.isNaN(remaining) || remaining <= 0) return 'expired';
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
