import { Command } from 'commander';
import { text, password, isCancel, note } from '@clack/prompts';
import {
  buildLoginUrl,
  computeChecksum,
  generateState,
  waitForCallback,
  openBrowser,
  redirectUrlFor,
} from '../core/auth.js';
import { setSecret, deleteAllSecrets, getSecret, keyringAvailable } from '../core/credentials.js';
import { saveConfig, SANDBOX_CREDENTIALS } from '../core/config.js';
import {
  saveSessionMeta,
  clearSessionMeta,
  loadSessionMeta,
  nextTokenExpiry,
  isExpired,
  timeUntilExpiry,
} from '../core/session.js';
import { KiteCliError, ExitCode, AbortedError } from '../core/errors.js';
import { registerSecret, maskSecret } from '../core/redact.js';
import { renderKeyValue } from '../output/table.js';
import { dateTime } from '../output/format.js';
import type { Context } from '../context.js';
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
    .action(run(whoami));
};

async function login(
  ctx: Context,
  opts: { manual?: boolean; apiKey?: string; force?: boolean },
): Promise<void> {
  const { io } = ctx;

  if (!opts.force && ctx.client.hasSession() && ctx.session && !isExpired(ctx.session)) {
    io.success(
      `Already logged in as ${io.bold(ctx.session.userName ?? ctx.session.userId)} ` +
        `(expires in ${timeUntilExpiry(ctx.session)}).`,
    );
    io.info('Use --force to log in again.');
    return;
  }

  const isSandbox = ctx.env === 'sandbox';

  // --- credentials -------------------------------------------------------
  let apiKey = opts.apiKey ?? (isSandbox ? SANDBOX_CREDENTIALS.apiKey : ctx.config.apiKey ?? '');
  let apiSecret: string;

  if (isSandbox) {
    apiKey = SANDBOX_CREDENTIALS.apiKey;
    apiSecret = SANDBOX_CREDENTIALS.apiSecret;
    io.info('Using the public sandbox credentials. No real money is involved.');
  } else {
    if (!apiKey) {
      apiKey = await promptText('Kite Connect API key', 'Create an app at https://developers.kite.trade to get one.');
    }

    const stored = await getSecret('api_secret', { env: ctx.env });
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
  const backend = await setSecret('access_token', session.access_token, { env: ctx.env });
  if (!isSandbox) {
    await setSecret('api_secret', apiSecret, { env: ctx.env });
  }

  const expiresAt = nextTokenExpiry();
  await saveSessionMeta({
    userId: session.user_id,
    userName: session.user_name,
    broker: session.broker,
    env: ctx.env,
    apiKey,
    expiresAt: expiresAt.toISOString(),
    loginTime: session.login_time,
    exchanges: session.exchanges,
    products: session.products,
  });

  if (ctx.config.apiKey !== apiKey && !isSandbox) {
    await saveConfig({ ...ctx.config, apiKey });
  }

  if (io.json) {
    io.writeJson({
      user_id: session.user_id,
      user_name: session.user_name,
      env: ctx.env,
      expires_at: expiresAt.toISOString(),
      storage: backend,
    });
    return;
  }

  io.success(`Logged in as ${io.bold(session.user_name ?? session.user_id)}.`);
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

  const opened = await openBrowser(loginUrl);
  if (opened) {
    io.info('Opened your browser to complete login…');
  } else {
    io.warn('Could not open a browser automatically. Open this URL manually:');
    io.note(`  ${loginUrl}`);
  }
  io.info('Waiting for the callback (Ctrl-C to abort)…');

  try {
    const result = await server.promise;
    return result.requestToken;
  } finally {
    server.close();
  }
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

  // Best-effort server-side invalidation; a failure here must not stop us
  // clearing local state, or the user is stuck with credentials they cannot
  // remove.
  if (ctx.client.hasSession()) {
    const stored = await getSecret('access_token', { env: ctx.env });
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
    await deleteAllSecrets({ env: ctx.env });
  } else {
    await deleteSecret('access_token', { env: ctx.env });
  }
  await clearSessionMeta();

  if (io.json) {
    io.writeJson({ logged_out: true, removed_api_secret: Boolean(opts.all) });
    return;
  }

  io.success(opts.all ? 'Logged out and removed the stored API secret.' : 'Logged out.');
  if (!opts.all) io.info('Your API secret is still stored. Use `kite logout --all` to remove it.');
}

async function whoami(ctx: Context): Promise<void> {
  const { io } = ctx;
  const meta = await loadSessionMeta();

  if (!ctx.client.hasSession()) {
    // Exit non-zero in both modes: a script checking `kite whoami` must be able
    // to branch on the exit code, not parse stdout.
    process.exitCode = ExitCode.Auth;
    if (io.json) {
      io.writeJson({ logged_in: false });
      return;
    }
    io.error('Not logged in.');
    io.info('Run `kite login` to start a session.');
    return;
  }

  // Hit the API so this reflects reality, not just what we cached.
  const profile = await ctx.api.getProfile(ctx.signal);

  if (io.json) {
    io.writeJson({
      logged_in: true,
      env: ctx.env,
      expires_at: meta?.expiresAt,
      profile,
    });
    return;
  }

  io.line(
    renderKeyValue(io, [
      ['User', `${profile.user_name ?? '—'} (${profile.user_id})`],
      ['Email', profile.email ?? '—'],
      ['Broker', profile.broker ?? '—'],
      ['Environment', ctx.env === 'sandbox' ? io.cyan('sandbox') : 'production'],
      ['Exchanges', profile.exchanges.join(', ') || '—'],
      ['Products', profile.products.join(', ') || '—'],
      [
        'Session expires',
        meta ? `${dateTime(meta.expiresAt)} IST (${timeUntilExpiry(meta)} left)` : 'unknown (token from environment)',
      ],
      ['Keyring', (await keyringAvailable()) ? 'available' : 'unavailable (using encrypted file)'],
    ]),
  );
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
