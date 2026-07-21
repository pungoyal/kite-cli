import { KiteApi } from './core/api.js';
import { KiteClient } from './core/client.js';
import {
  type Config,
  type Endpoints,
  type Environment,
  endpointsFor,
  loadConfig,
  resolveEnv,
  SANDBOX_CREDENTIALS,
} from './core/config.js';
import { getSecret } from './core/credentials.js';
import { AuthRequiredError, ExitCode, KiteCliError } from './core/errors.js';
import { InstrumentStore } from './core/instruments.js';
import { RateLimiter } from './core/ratelimit.js';
import { registerSecret } from './core/redact.js';
import { isExpired, loadSessionMeta, type SessionMeta } from './core/session.js';
import { Io, type IoStreams } from './output/io.js';

/**
 * Everything a command needs, assembled once per invocation.
 *
 * Construction is deliberately lazy about authentication: `kite login`,
 * `kite config` and `kite --help` must work with no session at all, so the
 * client is built without a token and commands call `requireSession()` when
 * they actually need one.
 */

export interface GlobalOptions {
  json?: boolean;
  color?: 'auto' | 'always' | 'never';
  quiet?: boolean;
  debug?: boolean;
  env?: string;
  yes?: boolean;
  dryRun?: boolean;
}

export interface Context {
  io: Io;
  config: Config;
  env: Environment;
  endpoints: Endpoints;
  client: KiteClient;
  api: KiteApi;
  instruments: InstrumentStore;
  session: SessionMeta | null;
  options: GlobalOptions;
  signal: AbortSignal;
  /** Throw unless there is a live session. */
  requireSession: () => SessionMeta;
  /** Resolve the API secret, for flows that need to sign (login only). */
  requireApiSecret: () => Promise<string>;
}

export async function createContext(
  options: GlobalOptions,
  signal: AbortSignal,
  streams?: IoStreams,
): Promise<Context> {
  const config = await loadConfig();
  const env = resolveEnv(options.env, config);
  const endpoints = endpointsFor(env);

  const io = new Io({
    json: options.json ?? false,
    color: options.color ?? config.output.color,
    quiet: options.quiet ?? false,
    // Threaded through so run() can be driven in-process by tests and by
    // embedders. Without this every command would write to the real
    // process streams regardless of what the caller asked for.
    ...(streams ? { streams } : {}),
  });

  const apiKey = resolveApiKey(config, env);

  const session = await loadSessionMeta();
  const accessToken = await resolveAccessToken(env, session, apiKey, io);

  const client = new KiteClient({
    apiKey,
    accessToken,
    endpoints,
    limiter: new RateLimiter(),
    debug: options.debug ?? false,
    onDebug: (message) => io.note(io.dim(message)),
  });

  const api = new KiteApi(client);
  const instruments = new InstrumentStore(api, env);

  const requireSession = (): SessionMeta => {
    if (!client.hasSession()) {
      throw new AuthRequiredError(
        env === 'sandbox' ? 'No sandbox session. Run `kite login --env sandbox`.' : 'Not logged in.',
      );
    }
    // A session file is absent when credentials came from the environment,
    // which is the normal CI path — synthesise a minimal record.
    if (!session) {
      return {
        userId: 'unknown',
        env,
        apiKey,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        exchanges: [],
        products: [],
      };
    }
    return session;
  };

  const requireApiSecret = async (): Promise<string> => {
    if (env === 'sandbox') return SANDBOX_CREDENTIALS.apiSecret;
    const found = await getSecret('api_secret', { env });
    if (!found) {
      throw new KiteCliError(
        'No API secret is stored.',
        ExitCode.Auth,
        'Run `kite login` and paste your API secret when prompted, or set KITE_API_SECRET.',
      );
    }
    return found.value;
  };

  return {
    io,
    config,
    env,
    endpoints,
    client,
    api,
    instruments,
    session,
    options,
    signal,
    requireSession,
    requireApiSecret,
  };
}

function resolveApiKey(config: Config, env: Environment): string {
  const fromEnv = process.env['KITE_API_KEY'];
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  if (env === 'sandbox') return SANDBOX_CREDENTIALS.apiKey;
  if (config.apiKey) return config.apiKey;
  // Deliberately not fatal here: `kite login` sets this up, and `kite config`
  // must remain usable before it exists.
  return '';
}

async function resolveAccessToken(
  env: Environment,
  session: SessionMeta | null,
  apiKey: string,
  io: Io,
): Promise<string | undefined> {
  let found: Awaited<ReturnType<typeof getSecret>>;
  try {
    found = await getSecret('access_token', { env });
  } catch (err) {
    // A corrupt or wrong-passphrase credential file must not brick the CLI.
    // This runs during context construction for EVERY command, so throwing
    // here would break `kite login` and `kite logout` — the two commands that
    // could actually fix the situation, and the ones the error tells you to run.
    io.warn(err instanceof Error ? err.message : 'Could not read stored credentials.');
    io.warn('Continuing without a session. Run `kite login` to re-authenticate.');
    return undefined;
  }
  if (!found) return undefined;

  registerSecret(found.value);

  // An env-supplied token is taken at face value: the caller is a script that
  // knows what it is doing, and we have no metadata to validate against.
  if (found.backend === 'env') return found.value;

  if (!session) return found.value;

  // The stored token belongs to a different environment or API key — treat it
  // as absent rather than sending a token that will 403.
  if (session.env !== env) return undefined;
  if (apiKey && session.apiKey && session.apiKey !== apiKey) return undefined;

  // Locally-known expiry is a floor, not a guarantee: a master logout from Kite
  // web kills the token early and is undetectable until a 403 comes back. We
  // still short-circuit the obvious case to save a round trip.
  if (isExpired(session)) return undefined;

  return found.value;
}
