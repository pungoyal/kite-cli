import { type Config, type Environment, EnvironmentSchema, SANDBOX_CREDENTIALS, type TradingConfig } from './config.js';
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
 * Two profile names are reserved:
 *   - `default`  — today's single-account setup (top-level apiKey/env in config,
 *                  secrets stored unprefixed). Chosen so existing installs need
 *                  no migration.
 *   - `sandbox`  — Zerodha's public sandbox. One fixed identity, so there is no
 *                  value in per-account sandbox profiles.
 */

export const DEFAULT_PROFILE = 'default';
export const SANDBOX_PROFILE = 'sandbox';
export const RESERVED_PROFILES = [DEFAULT_PROFILE, SANDBOX_PROFILE] as const;

/** Filesystem- and keyring-safe. Also keeps names out of `profile:<n>:` key collisions. */
const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

export interface ResolvedProfile {
  name: string;
  /** Semi-public Kite Connect API key. Empty until the profile is logged in. */
  apiKey: string;
  env: Environment;
  /** Per-profile trading overrides, or undefined to use the global settings. */
  trading: Config['profiles'][string]['trading'];
  /**
   * True when the caller named this profile explicitly (`--profile` / KITE_PROFILE),
   * as opposed to falling back to the configured default or the `--env` alias.
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
 * The reserved profiles reproduce the historical env-keyed scheme byte-for-byte
 * (`production` unprefixed, `sandbox:` otherwise), so no stored secret has to be
 * migrated. Every other profile gets a `profile:<name>:` namespace that cannot
 * collide with an env name.
 */
export function storagePrefixFor(profile: Pick<ResolvedProfile, 'name' | 'env'>): string {
  if (profile.name === DEFAULT_PROFILE || profile.name === SANDBOX_PROFILE) {
    return profile.env === 'production' ? '' : `${profile.env}:`;
  }
  return `profile:${profile.name}:`;
}

/** Every profile the user has, reserved ones first, without duplicates. */
export function listProfileNames(config: Config): string[] {
  const names = [DEFAULT_PROFILE, SANDBOX_PROFILE];
  for (const name of Object.keys(config.profiles)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function isKnownProfile(config: Config, name: string): boolean {
  return name === DEFAULT_PROFILE || name === SANDBOX_PROFILE || Object.hasOwn(config.profiles, name);
}

/**
 * Look up a profile by name without applying command-line overrides.
 *
 * An unknown name yields an empty, production profile rather than throwing, so
 * `kite --profile new login` (and `profiles add`) can create it.
 */
export function getProfile(config: Config, name: string): ResolvedProfile {
  if (name === SANDBOX_PROFILE) {
    return { name, apiKey: SANDBOX_CREDENTIALS.apiKey, env: 'sandbox', trading: undefined, explicit: false };
  }
  if (name === DEFAULT_PROFILE) {
    return { name, apiKey: config.apiKey ?? '', env: config.env, trading: undefined, explicit: false };
  }
  const p = config.profiles[name];
  return {
    name,
    apiKey: p?.apiKey ?? '',
    env: p?.env ?? 'production',
    trading: p?.trading,
    explicit: false,
  };
}

function parseEnvFlag(value: string | undefined): Environment | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const result = EnvironmentSchema.safeParse(value);
  if (!result.success) {
    throw new KiteCliError(`Unknown environment "${value}". Expected "production" or "sandbox".`, ExitCode.Usage);
  }
  return result.data;
}

export interface ProfileSelectors {
  /** The `--profile` flag value, if any. */
  profileFlag?: string | undefined;
  /** The `--env` flag value, if any. */
  envFlag?: string | undefined;
}

/**
 * Resolve the effective profile for this invocation.
 *
 * Precedence: `--profile` > KITE_PROFILE > (`--env sandbox` alias) >
 * `config.defaultProfile` > `default`. An explicit `--env`/KITE_ENV then
 * overrides the resolved profile's environment, so `--env production` still
 * forces production the way it always has.
 */
export function resolveProfile(selectors: ProfileSelectors, config: Config): ResolvedProfile {
  const named = selectors.profileFlag?.trim() || process.env['KITE_PROFILE']?.trim() || '';
  const explicitEnv = parseEnvFlag(selectors.envFlag ?? process.env['KITE_ENV']);

  let name: string;
  let explicit: boolean;
  if (named) {
    assertValidProfileName(named);
    name = named;
    explicit = true;
  } else if (explicitEnv === 'sandbox') {
    // Back-compat: `--env sandbox` selects the sandbox profile. This is an alias,
    // not an explicit account choice, so it does not arm the env-var guard.
    name = SANDBOX_PROFILE;
    explicit = false;
  } else {
    name = config.defaultProfile ?? DEFAULT_PROFILE;
    explicit = false;
  }

  const base = getProfile(config, name);
  const env = explicitEnv ?? base.env;
  // Any profile resolved into the sandbox environment uses the public demo key —
  // in particular a `default` profile pinned to sandbox via `config.env`, which
  // would otherwise carry the (production) config apiKey and fail to authenticate.
  const apiKey = env === 'sandbox' ? SANDBOX_CREDENTIALS.apiKey : base.apiKey;
  return { ...base, apiKey, env, explicit };
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
