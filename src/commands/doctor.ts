import { stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Context } from '../context.js';
import { getSecret, keyringAvailable } from '../core/credentials.js';
import { ExitCode } from '../core/errors.js';
import { configFile } from '../core/paths.js';
import { isExpired, timeUntilExpiry } from '../core/session.js';
import { renderKeyValue } from '../output/table.js';
import type { CommandFactory } from './types.js';

/**
 * `kite doctor` — an offline health check.
 *
 * Everything here is local: file permissions, keyring reachability, stored
 * credentials, cached session expiry, callback-port availability, and the Node
 * version. It deliberately makes no network call — that keeps it fast and
 * deterministic, and avoids spending a quote or (paid, tightly rate-limited)
 * historical unit just to answer "is my setup sane". Whether the session is
 * actually still alive on Kite's side can only be known by making a request, so
 * that check is delegated to `kite whoami`, which this points at.
 *
 * Exit code: non-zero only on a hard failure (a `fail` check). Warnings —
 * no session, no keyring, a busy port — are advisory and keep a zero exit, so
 * `doctor` reports health without doubling as an auth gate.
 */

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Status;
  detail: string;
  hint?: string;
}

export const doctorCommands: CommandFactory = (program, run) => {
  program
    .command('doctor')
    .description('Run offline health checks on your configuration, credentials, and session')
    .action(run(doctor));
};

async function doctor(ctx: Context): Promise<void> {
  const checks: Check[] = [
    checkNode(),
    await checkConfigFile(),
    await checkKeyring(),
    await checkCredentials(ctx),
    checkSession(ctx),
    await checkCallbackPort(ctx),
  ];

  const worst = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';

  if (ctx.io.json) {
    ctx.io.writeJson({
      ok: worst !== 'fail',
      profile: ctx.profile.name,
      env: ctx.env,
      checks: checks.map((c) => ({
        name: c.name,
        status: c.status,
        detail: c.detail,
        ...(c.hint ? { hint: c.hint } : {}),
      })),
    });
    if (worst === 'fail') process.exitCode = ExitCode.Failure;
    return;
  }

  const { io } = ctx;
  const rows: [string, string][] = [];
  for (const check of checks) {
    rows.push([`${icon(io, check.status)} ${check.name}`, check.detail]);
    if (check.hint) rows.push(['', io.dim(check.hint)]);
  }
  io.line(renderKeyValue(io, rows));

  io.note('');
  if (worst === 'fail') {
    io.error('Some checks failed. See the hints above.');
    process.exitCode = ExitCode.Failure;
  } else if (worst === 'warn') {
    io.warn('All essential checks passed, with warnings.');
    io.info('Run `kite whoami` to confirm the session is live on Kite (doctor is offline).');
  } else {
    io.success('Everything looks healthy.');
    io.info('Run `kite whoami` to confirm the session against Kite (doctor is offline).');
  }
}

// --- individual checks -----------------------------------------------------

/** Node must meet the floor declared in package.json `engines`. */
function checkNode(): Check {
  const current = process.versions.node;
  const floor = '22.12.0';
  return meetsFloor(current, floor)
    ? { name: 'Node runtime', status: 'ok', detail: `v${current}` }
    : {
        name: 'Node runtime',
        status: 'fail',
        detail: `v${current} is below the required v${floor}`,
        hint: `Upgrade to Node ${floor} or newer.`,
      };
}

async function checkConfigFile(): Promise<Check> {
  const path = configFile();
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No file is fine — defaults apply until the first `config set`.
      return { name: 'Config file', status: 'ok', detail: 'none yet (using built-in defaults)' };
    }
    return { name: 'Config file', status: 'fail', detail: `cannot read ${path}`, hint: (err as Error).message };
  }

  // Windows models permissions through ACLs, not the POSIX mode bits, so the
  // 0600 assertion only makes sense off Windows.
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    const mode = (info.mode & 0o777).toString(8).padStart(3, '0');
    return {
      name: 'Config file',
      status: 'warn',
      detail: `${path} is mode ${mode} (world- or group-readable)`,
      hint: `Tighten it: chmod 600 ${path}`,
    };
  }
  return { name: 'Config file', status: 'ok', detail: path };
}

async function checkKeyring(): Promise<Check> {
  return (await keyringAvailable())
    ? { name: 'Credential store', status: 'ok', detail: 'OS keyring available' }
    : {
        name: 'Credential store',
        status: 'warn',
        detail: 'no OS keyring — falling back to an encrypted file',
        hint: 'Set KITE_CREDENTIALS_PASSPHRASE to enable the encrypted file store on this machine.',
      };
}

async function checkCredentials(ctx: Context): Promise<Check> {
  if (ctx.env === 'sandbox') {
    return { name: 'API secret', status: 'ok', detail: 'using the public sandbox credentials' };
  }
  const secret = await getSecret('api_secret', { scope: ctx.credentialScope });
  return secret
    ? { name: 'API secret', status: 'ok', detail: `stored (${secret.backend})` }
    : {
        name: 'API secret',
        status: 'warn',
        detail: 'not stored',
        hint: 'Run `kite login` (or set KITE_API_SECRET) so re-login and signing work.',
      };
}

/** Cached session metadata only — liveness against Kite is `kite whoami`'s job. */
function checkSession(ctx: Context): Check {
  const loginHint =
    ctx.profile.name === 'default' ? 'Run `kite login`.' : `Run \`kite --profile ${ctx.profile.name} login\`.`;

  if (!ctx.session) {
    return { name: 'Session', status: 'warn', detail: 'not logged in', hint: loginHint };
  }
  if (isExpired(ctx.session)) {
    return {
      name: 'Session',
      status: 'warn',
      detail: 'expired (Kite invalidates tokens at 06:00 IST daily)',
      hint: loginHint,
    };
  }
  const who = ctx.session.userName ?? ctx.session.userId;
  return { name: 'Session', status: 'ok', detail: `${who}, expires in ${timeUntilExpiry(ctx.session)}` };
}

async function checkCallbackPort(ctx: Context): Promise<Check> {
  const port = ctx.config.redirectPort;
  const free = await portIsFree(port);
  return free
    ? { name: 'Login callback port', status: 'ok', detail: `127.0.0.1:${port} is free` }
    : {
        name: 'Login callback port',
        status: 'warn',
        detail: `127.0.0.1:${port} is in use`,
        hint: 'Another process holds the callback port; `kite login` may fail until it frees, or change redirectPort.',
      };
}

// --- helpers ---------------------------------------------------------------

function icon(io: Context['io'], status: Status): string {
  switch (status) {
    case 'ok':
      return io.green('✓');
    case 'warn':
      return io.yellow('!');
    case 'fail':
      return io.red('✗');
  }
}

/** True when `current` is >= `floor`, comparing major.minor.patch numerically. */
export function meetsFloor(current: string, floor: string): boolean {
  const c = current.split('.').map((n) => Number.parseInt(n, 10));
  const f = floor.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const a = c[i] ?? 0;
    const b = f[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Bind-and-release probe: can `kite login` open its loopback callback server? */
function portIsFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}
