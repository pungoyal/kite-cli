import type { Config, TradingConfig } from './config.js';
import { ExitCode, KiteCliError } from './errors.js';

/**
 * Multi-account resolution.
 *
 * A *profile* is a named Zerodha account. Selection is stateless per invocation
 * — there is deliberately no sticky "active account" that persists across
 * commands, because forgetting which account is active while placing real
 * orders is exactly the mistake this feature must not introduce. Instead the
 * target is resolved fresh every run, and the money-moving preview shows the
 * verified user id (see `safety.ts`).
 *
 * One profile name is reserved: `default` — today's single-account setup
 * (top-level apiKey in config, secrets stored unprefixed). Chosen so existing
 * installs need no migration.
 */

export const DEFAULT_PROFILE = 'default';
export const RESERVED_PROFILES = [DEFAULT_PROFILE] as const;

/** Filesystem- and keyring-safe. Also keeps names out of `profile:<n>:` key collisions. */
const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

export interface ResolvedProfile {
  name: string;
  /** Semi-public Kite Connect API key. Empty until the profile is logged in. */
  apiKey: string;
  /** Per-profile trading overrides, or undefined to use the global settings. */
  trading: Config['profiles'][string]['trading'];
  /**
   * True when the caller named this profile explicitly (`--profile` / KITE_PROFILE),
   * as opposed to falling back to the configured default.
   * Drives the fail-closed guard against an ambient KITE_ACCESS_TOKEN silently
   * overriding an explicitly chosen account.
   */
  explicit: boolean;
}

/** Reject names that could escape a filename or collide with a reserved prefix. */
export function assertValidProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new KiteCliError(
      `Invalid profile name "${name}".`,
      ExitCode.Usage,
      'Use 1–32 characters: letters, digits, hyphen or underscore, starting alphanumeric.',
    );
  }
}

/**
 * Keyring / encrypted-file namespace for a profile's secrets.
 *
 * The reserved `default` profile keeps the historical unprefixed keys the
 * single-account CLI has always written, so no stored secret has to be
 * migrated. Every other profile gets a `profile:<name>:` namespace.
 */
export function storagePrefixFor(profile: Pick<ResolvedProfile, 'name'>): string {
  if (profile.name === DEFAULT_PROFILE) return '';
  return `profile:${profile.name}:`;
}

/** Every profile the user has, reserved ones first, without duplicates. */
export function listProfileNames(config: Config): string[] {
  const names = [DEFAULT_PROFILE];
  for (const name of Object.keys(config.profiles)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function isKnownProfile(config: Config, name: string): boolean {
  return name === DEFAULT_PROFILE || Object.hasOwn(config.profiles, name);
}

/**
 * Look up a profile by name without applying command-line overrides.
 *
 * An unknown name yields an empty profile rather than throwing, so
 * `kite --profile new login` (and `profiles add`) can create it.
 */
export function getProfile(config: Config, name: string): ResolvedProfile {
  if (name === DEFAULT_PROFILE) {
    return { name, apiKey: config.apiKey ?? '', trading: undefined, explicit: false };
  }
  const p = config.profiles[name];
  return {
    name,
    apiKey: p?.apiKey ?? '',
    trading: p?.trading,
    explicit: false,
  };
}

export interface ProfileSelectors {
  /** The `--profile` flag value, if any. */
  profileFlag?: string | undefined;
}

/**
 * Resolve the effective profile for this invocation.
 *
 * Precedence: `--profile` > KITE_PROFILE > `config.defaultProfile` > `default`.
 */
export function resolveProfile(selectors: ProfileSelectors, config: Config): ResolvedProfile {
  const named = selectors.profileFlag?.trim() || process.env['KITE_PROFILE']?.trim() || '';

  let name: string;
  let explicit: boolean;
  if (named) {
    assertValidProfileName(named);
    name = named;
    explicit = true;
  } else {
    name = config.defaultProfile ?? DEFAULT_PROFILE;
    explicit = false;
  }

  const base = getProfile(config, name);
  return { ...base, explicit };
}

/**
 * The trading config actually in force: global settings overlaid with the
 * profile's overrides. Fail-closed by construction — a field the profile leaves
 * unset falls back to the global value, so an omitted cap never becomes "no cap".
 */
export function resolveTradingConfig(config: Config, profile: ResolvedProfile): TradingConfig {
  const base = config.trading;
  const o = profile.trading;
  if (!o) return base;
  return {
    enabled: o.enabled ?? base.enabled,
    confirm: o.confirm ?? base.confirm,
    maxOrderValue: o.maxOrderValue ?? base.maxOrderValue,
    strictConfirmAbove: o.strictConfirmAbove ?? base.strictConfirmAbove,
  };
}
