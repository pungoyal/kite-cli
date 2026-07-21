import { chmod, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ExitCode, KiteCliError } from './errors.js';
import { configDir, configFile, ensurePrivateDir } from './paths.js';

/**
 * User configuration, persisted at ~/.config/kite/config.json.
 *
 * Note what is deliberately absent: there is no `yes` / `assumeYes` setting.
 * Bypassing a confirmation prompt must be explicit at the call site every time,
 * so `--yes` is a flag only. A config file that silently disables confirmations
 * is exactly how an accidental order gets placed.
 */

export const EnvironmentSchema = z.enum(['production', 'sandbox']);
export type Environment = z.infer<typeof EnvironmentSchema>;

export const TradingSchema = z.object({
  /**
   * Local kill switch. When false, every order-placing, order-modifying and
   * GTT-mutating command refuses before touching the network.
   */
  enabled: z.boolean().default(true),
  /** Require an interactive confirmation before any money-moving action. */
  confirm: z.boolean().default(true),
  /**
   * Refuse any single order whose notional value exceeds this (rupees).
   * Undefined means no cap.
   */
  maxOrderValue: z.number().positive().optional(),
  /**
   * Above this notional value, require typing a literal token to confirm
   * rather than a single keystroke.
   */
  strictConfirmAbove: z.number().positive().default(100_000),
});
export type TradingConfig = z.infer<typeof TradingSchema>;

/**
 * Per-profile trading overrides. Every field is optional with NO default:
 * an absent field means "inherit the global setting", never "no limit". That
 * inheritance is deliberately fail-closed — a profile that omits a cap must
 * still be bound by the global cap, or the one guard the user configured would
 * silently stop applying to their other accounts.
 */
export const ProfileTradingSchema = z.object({
  enabled: z.boolean().optional(),
  confirm: z.boolean().optional(),
  maxOrderValue: z.number().positive().optional(),
  strictConfirmAbove: z.number().positive().optional(),
});
export type ProfileTradingOverrides = z.infer<typeof ProfileTradingSchema>;

/**
 * A named account. Each real Zerodha account has its own Kite Connect app, so a
 * profile carries its own (semi-public) api key and env; its api secret and
 * access token live in the keyring / encrypted file, namespaced by profile.
 */
export const ProfileConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
  env: EnvironmentSchema.optional(),
  trading: ProfileTradingSchema.optional(),
});
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;

export const ConfigSchema = z.object({
  /** Kite Connect API key. Semi-public (it appears in login URLs), so not a keyring secret. */
  apiKey: z.string().min(1).optional(),

  env: EnvironmentSchema.default('production'),

  trading: TradingSchema.prefault({}),

  /**
   * The profile used when none is named on the command line or in KITE_PROFILE.
   * Absent means the reserved `default` profile (top-level apiKey/env above).
   */
  defaultProfile: z.string().min(1).optional(),

  /**
   * Named accounts beyond `default`. The `default` and `sandbox` profiles are
   * reserved and synthesised, so they never need an entry here.
   */
  profiles: z.record(z.string(), ProfileConfigSchema).default({}),

  output: z
    .object({
      color: z.enum(['auto', 'always', 'never']).default('auto'),
      /** Default table style. */
      compact: z.boolean().default(false),
    })
    .prefault({}),

  /** Fixed loopback port for the OAuth redirect. Must match the developer console. */
  redirectPort: z.number().int().min(1).max(65535).default(51101),

  /** Path component of the redirect URL, e.g. "/callback". */
  redirectPath: z.string().startsWith('/').default('/callback'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export async function loadConfig(): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(configFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KiteCliError(
      `Config file at ${configFile()} is not valid JSON.`,
      ExitCode.Failure,
      'Fix it by hand, or delete it to start from defaults.',
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new KiteCliError(
      `Config file at ${configFile()} is invalid:\n${z.prettifyError(result.error)}`,
      ExitCode.Failure,
    );
  }
  return result.data;
}

export async function saveConfig(config: Config): Promise<void> {
  await ensurePrivateDir(configDir());
  const path = configFile();
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    encoding: 'utf8',
  });
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
  }
}

/**
 * The settings `kite config set` accepts.
 *
 * Declared explicitly rather than inferred from the schema, because optional
 * settings with no default (maxOrderValue) are indistinguishable from unknown
 * keys otherwise. This also drives value coercion and `--help` text.
 *
 * Note what is absent: there is no key for skipping confirmations. `--yes`
 * must be passed at the call site every time.
 */
export const SETTABLE_KEYS = {
  apiKey: { type: 'string', description: 'Kite Connect API key' },
  env: { type: 'string', description: 'production or sandbox' },
  'trading.enabled': {
    type: 'boolean',
    description: 'Master kill switch for all order commands',
  },
  'trading.confirm': {
    type: 'boolean',
    description: 'Require confirmation before money-moving actions',
  },
  'trading.maxOrderValue': {
    type: 'number',
    description: 'Refuse any single order above this rupee value',
  },
  'trading.strictConfirmAbove': {
    type: 'number',
    description: 'Above this rupee value, require typing the symbol to confirm',
  },
  'output.color': { type: 'string', description: 'auto, always, or never' },
  'output.compact': {
    type: 'boolean',
    description: 'Render tables without borders',
  },
  redirectPort: {
    type: 'number',
    description: 'Loopback port for the login callback',
  },
  redirectPath: {
    type: 'string',
    description: 'Path component of the login callback URL',
  },
} as const satisfies Record<string, { type: 'string' | 'number' | 'boolean'; description: string }>;

export type SettableKey = keyof typeof SETTABLE_KEYS;

export function isSettableKey(key: string): key is SettableKey {
  return Object.hasOwn(SETTABLE_KEYS, key);
}

/** Environment-specific API endpoints. */
export interface Endpoints {
  api: string;
  ws: string;
  login: string;
  /**
   * Sandbox serves every route under an /oms prefix — except /instruments.
   * Production has no prefix.
   */
  routePrefix: string;
}

export function endpointsFor(env: Environment): Endpoints {
  if (env === 'sandbox') {
    return {
      api: 'https://sandbox.kite.trade',
      ws: 'wss://ws-sandbox.kite.trade',
      login: 'https://sandbox.kite.trade/connect/login',
      routePrefix: '/oms',
    };
  }
  return {
    api: 'https://api.kite.trade',
    ws: 'wss://ws.kite.trade',
    login: 'https://kite.zerodha.com/connect/login',
    routePrefix: '',
  };
}

/** Public sandbox credentials, documented at https://kite.trade/docs/connect/v3/sandbox/ */
export const SANDBOX_CREDENTIALS = {
  apiKey: 'sandboxdemo',
  apiSecret: 'sandboxdemo-secret',
} as const;

/** Resolve the effective environment: --env flag > KITE_ENV > config > production. */
export function resolveEnv(flag: string | undefined, config: Config): Environment {
  const candidate = flag ?? process.env['KITE_ENV'] ?? config.env;
  const result = EnvironmentSchema.safeParse(candidate);
  if (!result.success) {
    throw new KiteCliError(`Unknown environment "${candidate}". Expected "production" or "sandbox".`, ExitCode.Usage);
  }
  return result.data;
}
