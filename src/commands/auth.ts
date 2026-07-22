import { isCancel, note, password, text } from '@clack/prompts';
import type { Context } from '../context.js';
import {
  buildLoginUrl,
  computeChecksum,
  copyToClipboard,
  generateState,
  openBrowser,
  redirectUrlFor,
  waitForCallback,
} from '../core/auth.js';
import { type Environment, loadConfig, SANDBOX_CREDENTIALS, saveConfig } from '../core/config.js';
import { deleteAllSecrets, getSecret, keyringAvailable, setSecret } from '../core/credentials.js';
import { AbortedError, ExitCode, KiteCliError } from '../core/errors.js';
import { getProfile, listProfileNames } from '../core/profiles.js';
import { maskSecret, registerSecret } from '../core/redact.js';
import {
  clearSessionMeta,
  isExpired,
  loadSessionMeta,
  nextTokenExpiry,
  saveSessionMeta,
  timeUntilExpiry,
} from '../core/session.js';
import { dateTime } from '../output/format.js';
import { printTable, renderKeyValue } from '../output/table.js';
import type { CommandFactory } from './types.js';

export const authCommands: CommandFactory = (program, run) => {
  program
    .command('login')
    .description('Authenticate with Kite and store a session')
    .option('--manual', 'Paste the request token by hand instead of using a local callback server')
    .option('--api-key <key>', 'Kite Connect API key (prompted for if absent)')
    .option('--force', 'Log in again even if the current session is still valid')
    .action(run(login));

  program
    .command('logout')
    .description('Invalidate the session and remove the stored access token')
    .option('--all', 'Also remove the stored API secret')
    .action(run(logout));

  program
    .command('whoami')
    .description('Show the current session and account details')
    .option('--all', 'List every configured profile and its session status')
    .action(run(whoami));
};

async function login(ctx: Context, opts: { manual?: boolean; apiKey?: string; force?: boolean }): Promise<void> {
  const { io } = ctx;
  const profileName = ctx.profile.name;

  if (!opts.force && ctx.client.hasSession() && ctx.session && !isExpired(ctx.session)) {
    io.success(
      `Already logged in as ${io.bold(ctx.session.userName ?? ctx.session.userId)} ` +
        `(expires in ${timeUntilExpiry(ctx.session)}).`,
    );
    io.info('Use --force to log in again.');
    return;
  }

  const isSandbox = ctx.env === 'sandbox';
  if (profileName !== 'default' && !isSandbox) {
    io.info(`Logging in to profile ${io.bold(profileName)}.`);
  }

  // --- credentials -------------------------------------------------------
  let apiKey = opts.apiKey ?? (isSandbox ? SANDBOX_CREDENTIALS.apiKey : ctx.profile.apiKey);
  let apiSecret: string;

  if (isSandbox) {
    apiKey = SANDBOX_CREDENTIALS.apiKey;
    apiSecret = SANDBOX_CREDENTIALS.apiSecret;
    io.info('Using the public sandbox credentials. No real money is involved.');
  } else {
    if (!apiKey) {
      apiKey = await promptText('Kite Connect API key', 'Create an app at https://developers.kite.trade to get one.');
    }

    const stored = await getSecret('api_secret', { scope: ctx.credentialScope });
    if (stored && !opts.force) {
      apiSecret = stored.value;
      io.info(`Using stored API secret (${maskSecret(apiSecret)}) from the ${stored.backend}.`);
    } else {
      // Prompted, never accepted as a CLI argument: argv is visible to any
      // local process via `ps`, and lands in shell history.
      apiSecret = await promptSecret('Kite Connect API secret');
    }
  }

  registerSecret(apiSecret);
  ctx.client.setAccessToken(undefined);

  // --- obtain a request token --------------------------------------------
  const state = generateState();
  const loginUrl = buildLoginUrl({ apiKey, endpoints: ctx.endpoints, state });

  let requestToken: string;

  if (opts.manual) {
    requestToken = await manualFlow(ctx, loginUrl);
  } else {
    requestToken = await callbackFlow(ctx, loginUrl);
  }

  // --- exchange for an access token --------------------------------------
  const checksum = computeChecksum(apiKey, requestToken, apiSecret);

  // Rebuild the client with the right API key, in case this is a first login.
  const { KiteClient } = await import('../core/client.js');
  const { KiteApi } = await import('../core/api.js');
  const client = new KiteClient({
    apiKey,
    endpoints: ctx.endpoints,
    limiter: ctx.client.limiter,
    debug: ctx.options.debug ?? false,
    onDebug: (message) => io.note(io.dim(message)),
  });
  const api = new KiteApi(client);

  const session = await api.createSession({ requestToken, checksum });
  registerSecret(session.access_token);

  // --- persist ------------------------------------------------------------
  const backend = await setSecret('access_token', session.access_token, {
    scope: ctx.credentialScope,
  });
  if (!isSandbox) {
    await setSecret('api_secret', apiSecret, { scope: ctx.credentialScope });
  }

  const expiresAt = nextTokenExpiry();
  await saveSessionMeta({
    userId: session.user_id,
    userName: session.user_name,
    broker: session.broker,
    env: ctx.env,
    apiKey,
    profile: profileName,
    expiresAt: expiresAt.toISOString(),
    loginTime: session.login_time,
    exchanges: session.exchanges,
    products: session.products,
  });

  // Register the profile's api key so subsequent runs find it, and so a new
  // named profile becomes discoverable in `kite profiles`. The sandbox uses the
  // public constant, so there is nothing worth persisting for it.
  if (!isSandbox) {
    await persistProfileApiKey(profileName, ctx.env, apiKey);
  }

  if (io.json) {
    io.writeJson({
      user_id: session.user_id,
      user_name: session.user_name,
      env: ctx.env,
      profile: profileName,
      expires_at: expiresAt.toISOString(),
      storage: backend,
    });
    return;
  }

  const asProfile = profileName === 'default' ? '' : ` on profile ${io.bold(profileName)}`;
  io.success(`Logged in as ${io.bold(session.user_name ?? session.user_id)}${asProfile}.`);
  io.info(`Session expires ${dateTime(expiresAt)} IST (Kite invalidates all tokens at 6 AM daily).`);
  io.info(
    backend === 'keyring'
      ? 'Credentials stored in your OS keyring.'
      : `Credentials stored in an encrypted file (no OS keyring available).`,
  );
}

/** Browser + loopback callback. The default, and the least error-prone path. */
async function callbackFlow(ctx: Context, loginUrl: string): Promise<string> {
  const { io } = ctx;
  const port = ctx.config.redirectPort;
  const path = ctx.config.redirectPath;
  const redirectUrl = redirectUrlFor(port, path);

  const server = waitForCallback({ port, path, state: extractState(loginUrl) });

  io.note('');
  io.info(`Your Kite app's redirect URL must be exactly: ${io.bold(redirectUrl)}`);
  io.info('Set it at https://developers.kite.trade if login fails.');
  io.note('');

  // Show the URL unconditionally: the browser may not have opened, may have
  // landed in the wrong profile, or the user may want to log in on another
  // device. The URL carries only the api_key and CSRF state — no token.
  io.info('Login URL:');
  io.note(`  ${loginUrl}`);
  io.note('');

  const opened = await openBrowser(loginUrl);
  if (opened) {
    io.info('Opened your browser to complete login…');
  } else {
    io.warn('Could not open a browser automatically. Open the URL above manually.');
  }

  // Let the user grab the URL without selecting it in the terminal. Copy-on-`c`
  // and Ctrl-C both funnel through `interrupted`, which loses the race against a
  // successful callback. A single Ctrl-C aborts the wait — raw mode swallows the
  // SIGINT, and the loopback promise never observes ctx.signal on its own.
  let interrupt: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = () => reject(new AbortedError('Interrupted.'));
  });
  const onAbort = () => interrupt();
  if (ctx.signal.aborted) onAbort();
  else ctx.signal.addEventListener('abort', onAbort, { once: true });
  const stopKeys = listenForKeys(ctx, loginUrl, interrupt);

  io.info(`Waiting for the callback (press ${io.bold('c')} to copy the login URL, Ctrl-C to abort)…`);

  try {
    const result = await Promise.race([server.promise, interrupted]);
    return result.requestToken;
  } finally {
    // Always restore the terminal and detach listeners, even on abort — the
    // loopback promise may never settle, so this cannot hang off it.
    stopKeys();
    ctx.signal.removeEventListener('abort', onAbort);
    server.close();
  }
}

/**
 * While waiting for the browser callback, listen for a `c` keypress to copy the
 * login URL, and for Ctrl-C to abort. Entering raw mode makes us responsible for
 * both restoring the terminal and re-handling Ctrl-C (raw mode no longer raises
 * SIGINT). Returns a no-op when stdin is not a TTY, and an idempotent cleanup
 * that both the caller and the Ctrl-C path can safely call.
 */
// Exported for tests: the raw-mode lifecycle (enter, restore, detach) and the
// Ctrl-C byte path are the risky parts, and a real TTY can't be driven in CI.
export function listenForKeys(ctx: Context, loginUrl: string, onInterrupt: () => void): () => void {
  const { io } = ctx;
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};

  const wasRaw = stdin.isRaw;
  let stopped = false;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    stdin.off('data', onData);
    stdin.setRawMode(wasRaw);
    stdin.pause();
  };

  const onData = (chunk: Buffer) => {
    // 0x03 is Ctrl-C, which raw mode delivers as a byte instead of a SIGINT.
    if (chunk.length === 1 && chunk[0] === 0x03) {
      cleanup();
      onInterrupt();
      return;
    }
    const key = chunk.toString('utf8');
    if (key === 'c' || key === 'C') {
      void copyToClipboard(loginUrl).then((ok) => {
        if (ok) io.success('Login URL copied to clipboard.');
        else io.warn('Could not copy to the clipboard (no clipboard tool found).');
      });
    }
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
  return cleanup;
}

/** Fallback for remote shells, where no browser can reach 127.0.0.1. */
async function manualFlow(ctx: Context, loginUrl: string): Promise<string> {
  const { io } = ctx;
  io.note('');
  io.info('Open this URL, log in, then copy the `request_token` from the redirect URL:');
  io.note(`  ${loginUrl}`);
  io.note('');

  const token = await promptText('request_token');
  if (!token) throw new AbortedError();
  registerSecret(token);
  return token;
}

function extractState(loginUrl: string): string {
  const params = new URL(loginUrl).searchParams.get('redirect_params') ?? '';
  return new URLSearchParams(params).get('state') ?? '';
}

async function logout(ctx: Context, opts: { all?: boolean }): Promise<void> {
  const { io } = ctx;
  const profileName = ctx.profile.name;

  // Best-effort server-side invalidation; a failure here must not stop us
  // clearing local state, or the user is stuck with credentials they cannot
  // remove.
  if (ctx.client.hasSession()) {
    const stored = await getSecret('access_token', { scope: ctx.credentialScope });
    if (stored) {
      try {
        await ctx.api.invalidateSession(stored.value);
        io.info('Session invalidated with Kite.');
      } catch {
        io.warn('Could not reach Kite to invalidate the session; clearing local credentials anyway.');
      }
    }
  }

  const { deleteSecret } = await import('../core/credentials.js');
  if (opts.all) {
    await deleteAllSecrets({ scope: ctx.credentialScope });
  } else {
    await deleteSecret('access_token', { scope: ctx.credentialScope });
  }
  await clearSessionMeta(profileName);

  const onProfile = profileName === 'default' ? '' : ` (profile ${io.bold(profileName)})`;

  if (io.json) {
    io.writeJson({ logged_out: true, profile: profileName, removed_api_secret: Boolean(opts.all) });
    return;
  }

  io.success(opts.all ? `Logged out and removed the stored API secret${onProfile}.` : `Logged out${onProfile}.`);
  if (!opts.all) io.info('Your API secret is still stored. Use `kite logout --all` to remove it.');
}

async function whoami(ctx: Context, opts: { all?: boolean }): Promise<void> {
  if (opts.all) {
    await whoamiAll(ctx);
    return;
  }

  const { io } = ctx;
  const profileName = ctx.profile.name;
  const meta = await loadSessionMeta(profileName);

  if (!ctx.client.hasSession()) {
    // Exit non-zero in both modes: a script checking `kite whoami` must be able
    // to branch on the exit code, not parse stdout.
    process.exitCode = ExitCode.Auth;
    if (io.json) {
      io.writeJson({ logged_in: false, profile: profileName });
      return;
    }
    io.error(profileName === 'default' ? 'Not logged in.' : `Not logged in to profile "${profileName}".`);
    io.info(
      profileName === 'default'
        ? 'Run `kite login` to start a session.'
        : `Run \`kite --profile ${profileName} login\`.`,
    );
    return;
  }

  // Hit the API so this reflects reality, not just what we cached.
  const account = await ctx.api.getProfile(ctx.signal);

  if (io.json) {
    io.writeJson({
      logged_in: true,
      env: ctx.env,
      profile: profileName,
      expires_at: meta?.expiresAt,
      account,
    });
    return;
  }

  io.line(
    renderKeyValue(io, [
      ['Profile', profileName === 'default' ? profileName : io.bold(profileName)],
      ['User', `${account.user_name ?? '—'} (${account.user_id})`],
      ['Email', account.email ?? '—'],
      ['Broker', account.broker ?? '—'],
      ['Environment', ctx.env === 'sandbox' ? io.cyan('sandbox') : 'production'],
      ['Exchanges', account.exchanges.join(', ') || '—'],
      ['Products', account.products.join(', ') || '—'],
      [
        'Session expires',
        meta ? `${dateTime(meta.expiresAt)} IST (${timeUntilExpiry(meta)} left)` : 'unknown (token from environment)',
      ],
      ['Keyring', (await keyringAvailable()) ? 'available' : 'unavailable (using encrypted file)'],
    ]),
  );
}

/** Enumerate every configured profile and its cached session, no network calls. */
async function whoamiAll(ctx: Context): Promise<void> {
  const { io } = ctx;
  const config = await loadConfig();
  const rows = await Promise.all(
    listProfileNames(config).map(async (name) => {
      const meta = await loadSessionMeta(name);
      const status = !meta
        ? io.dim('no session')
        : isExpired(meta)
          ? io.yellow('expired')
          : `expires in ${timeUntilExpiry(meta)}`;
      return {
        profile: name,
        env: getProfile(config, name).env,
        user: meta?.userName ?? meta?.userId ?? '—',
        session: status,
        current: name === ctx.profile.name,
      };
    }),
  );

  printTable(
    io,
    rows,
    [
      { header: '', value: (r) => (r.current ? io.green('●') : ' ') },
      { header: 'Profile', value: (r) => (r.current ? io.bold(r.profile) : r.profile) },
      { header: 'Env', value: (r) => (r.env === 'sandbox' ? io.cyan(r.env) : r.env) },
      { header: 'User', value: (r) => r.user },
      { header: 'Session', value: (r) => r.session },
    ],
    rows.map(({ current: _current, ...rest }) => rest),
  );
}

/**
 * Persist a profile's (semi-public) api key so later runs find it. The default
 * profile keeps its key at the top level of the config for back-compat; a named
 * profile is registered under `profiles`, which also makes it show up in
 * `kite profiles`. Reads the raw config fresh so the in-memory effective
 * trading overlay is never written back.
 */
async function persistProfileApiKey(profileName: string, env: Environment, apiKey: string): Promise<void> {
  const config = await loadConfig();
  if (profileName === 'default') {
    if (config.apiKey === apiKey) return;
    await saveConfig({ ...config, apiKey });
    return;
  }
  const existing = config.profiles[profileName];
  if (existing?.apiKey === apiKey && existing?.env === env) return;
  await saveConfig({
    ...config,
    profiles: { ...config.profiles, [profileName]: { ...existing, apiKey, env } },
  });
}

async function promptText(message: string, hint?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new KiteCliError(
      `${message} is required but this is not an interactive terminal.`,
      ExitCode.ConfirmationRequired,
      'Supply it via a flag or environment variable.',
    );
  }
  if (hint) note(hint);
  const answer = await text({
    message,
    validate: (value) => ((value ?? '').trim() === '' ? 'Required.' : undefined),
  });
  if (isCancel(answer)) throw new AbortedError();
  return String(answer).trim();
}

async function promptSecret(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new KiteCliError(
      `${message} is required but this is not an interactive terminal.`,
      ExitCode.ConfirmationRequired,
      'Set KITE_API_SECRET instead.',
    );
  }
  const answer = await password({
    message,
    validate: (value) => ((value ?? '').trim() === '' ? 'Required.' : undefined),
  });
  if (isCancel(answer)) throw new AbortedError();
  return String(answer).trim();
}
