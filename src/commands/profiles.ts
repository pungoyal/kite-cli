import { confirm, isCancel } from '@clack/prompts';
import type { Context } from '../context.js';
import { loadConfig, type ProfileConfig, saveConfig } from '../core/config.js';
import { deleteAllSecrets } from '../core/credentials.js';
import { AbortedError, ExitCode, KiteCliError, UsageError } from '../core/errors.js';
import {
  assertValidProfileName,
  DEFAULT_PROFILE,
  getProfile,
  isKnownProfile,
  listProfileNames,
  RESERVED_PROFILES,
  storagePrefixFor,
} from '../core/profiles.js';
import { clearSessionMeta, isExpired, loadSessionMeta, timeUntilExpiry } from '../core/session.js';
import { printTable, renderKeyValue } from '../output/table.js';
import { examples } from './examples.js';
import type { CommandFactory } from './types.js';

/**
 * Account profile management.
 *
 * Selection itself is stateless (`--profile` / KITE_PROFILE, resolved every
 * run); these commands only manage the persisted set of profiles and the
 * rarely-changed default. Logging in is deliberately left to `kite login` so
 * credential handling lives in exactly one place.
 */

export const profileCommands: CommandFactory = (program, run) => {
  const profiles = program
    .command('profiles')
    .description('Manage account profiles for multiple Zerodha accounts')
    .addHelpText(
      'after',
      examples([
        ['kite profiles', 'List profiles and their session status'],
        ['kite profiles add huf --api-key abcd1234efgh5678', 'Register a second account'],
        ['kite --profile huf login', 'Log in to it (each profile has its own session)'],
        ['kite --profile huf holdings', 'Run any command against it'],
        ['kite profiles use huf', 'Make it the default for future commands'],
      ]),
    );

  profiles
    .command('list', { isDefault: true })
    .alias('ls')
    .description('List configured profiles and their session status')
    .addHelpText(
      'after',
      examples([
        ['kite profiles list', 'Every profile, with which one is the default'],
        ['kite profiles ls --json', 'Machine-readable listing'],
      ]),
    )
    .action(run(listProfiles));

  profiles
    .command('add')
    .description('Register a new account profile (does not log in)')
    .argument('<name>', 'A short label, e.g. personal or huf')
    .option('--api-key <key>', 'Kite Connect API key for this account')
    .option('--max-order-value <rupees>', 'Per-profile cap on any single order')
    .addHelpText(
      'after',
      examples([
        ['kite profiles add huf', 'Prompt for the API key'],
        ['kite profiles add huf --api-key abcd1234efgh5678', 'Supply it up front'],
        ['kite profiles add huf --max-order-value 50000', 'Cap any single order on this account at ₹50,000'],
      ]),
    )
    .action(run(addProfile));

  profiles
    .command('remove')
    .alias('rm')
    .description('Delete a profile and its stored credentials')
    .argument('<name>')
    .addHelpText('after', examples([['kite profiles remove huf', 'Delete the profile, its API key and its session']]))
    .action(run(removeProfile));

  profiles
    .command('use')
    .description('Set the default profile for future commands')
    .argument('<name>')
    .addHelpText(
      'after',
      examples([
        ['kite profiles use huf', 'Commands without --profile now run against huf'],
        ['kite profiles use default', 'Go back to the unnamed default account'],
      ]),
    )
    .action(run(useProfile));

  profiles
    .command('current')
    .description('Show the profile this invocation resolves to')
    .addHelpText(
      'after',
      examples([
        ['kite profiles current', 'Which account a bare `kite holdings` would hit'],
        ['kite --profile huf profiles current', 'Check how an explicit --profile resolves'],
      ]),
    )
    .action(run(currentProfile));
};

async function listProfiles(ctx: Context): Promise<void> {
  const { io } = ctx;
  const config = await loadConfig();
  const rows = await Promise.all(
    listProfileNames(config).map(async (name) => {
      const profile = getProfile(config, name);
      const meta = await loadSessionMeta(name);
      return {
        profile: name,
        api_key: Boolean(profile.apiKey),
        default: (config.defaultProfile ?? DEFAULT_PROFILE) === name,
        current: name === ctx.profile.name,
        session: !meta
          ? io.dim('no session')
          : isExpired(meta)
            ? io.yellow('expired')
            : `expires in ${timeUntilExpiry(meta)}`,
      };
    }),
  );

  printTable(
    io,
    rows,
    [
      { header: '', value: (r) => (r.current ? io.green('●') : ' ') },
      { header: 'Profile', value: (r) => (r.current ? io.bold(r.profile) : r.profile) },
      { header: 'API key', value: (r) => (r.api_key ? io.green('set') : io.dim('—')) },
      { header: 'Default', value: (r) => (r.default ? '✓' : ' ') },
      { header: 'Session', value: (r) => r.session },
    ],
    rows.map(({ current: _current, ...rest }) => rest),
  );

  if (!io.json) {
    io.note('');
    io.info('Target a profile with `--profile <name>`, or set a default with `kite profiles use <name>`.');
  }
}

async function addProfile(
  ctx: Context,
  opts: { apiKey?: string; maxOrderValue?: string },
  command: { args: string[] },
): Promise<void> {
  const { io } = ctx;
  const name = command.args[0];
  if (!name) throw new UsageError('A profile name is required, e.g. `kite profiles add personal`.');
  assertValidProfileName(name);
  if ((RESERVED_PROFILES as readonly string[]).includes(name)) {
    throw new UsageError(`"${name}" is a reserved profile and always exists.`);
  }

  const config = await loadConfig();
  if (isKnownProfile(config, name)) {
    throw new UsageError(
      `Profile "${name}" already exists.`,
      'Use `kite profiles remove` first, or pick another name.',
    );
  }

  const entry: ProfileConfig = {};
  if (opts.apiKey) entry.apiKey = opts.apiKey;
  if (opts.maxOrderValue !== undefined) {
    const cap = Number(opts.maxOrderValue);
    if (!Number.isFinite(cap) || cap <= 0) throw new UsageError(`--max-order-value must be a positive number.`);
    entry.trading = { maxOrderValue: cap };
  }

  await saveConfig({ ...config, profiles: { ...config.profiles, [name]: entry } });

  if (io.json) {
    io.writeJson({ added: name, ...entry });
    return;
  }
  io.success(`Added profile ${io.bold(name)}.`);
  io.info(`Log in with \`kite --profile ${name} login\`.`);
}

async function removeProfile(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  const { io } = ctx;
  const name = command.args[0];
  if (!name) throw new UsageError('A profile name is required.');
  if ((RESERVED_PROFILES as readonly string[]).includes(name)) {
    throw new UsageError(`The reserved profile "${name}" cannot be removed.`);
  }

  const config = await loadConfig();
  if (!isKnownProfile(config, name)) {
    throw new UsageError(`No profile named "${name}".`, 'Run `kite profiles list` to see what exists.');
  }

  await confirmDestructive(ctx, `Remove profile "${name}" and its stored credentials?`);

  // Drop the token and secret for this profile, then its session and config entry.
  const scope = storagePrefixFor(getProfile(config, name));
  await deleteAllSecrets({ scope });
  await clearSessionMeta(name);

  const profiles = { ...config.profiles };
  delete profiles[name];
  const next = { ...config, profiles };
  // If this was the default, fall back to the reserved default rather than
  // leaving a dangling pointer.
  if (config.defaultProfile === name) delete next.defaultProfile;
  await saveConfig(next);

  if (io.json) {
    io.writeJson({ removed: name });
    return;
  }
  io.success(`Removed profile ${io.bold(name)}.`);
}

async function useProfile(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  const { io } = ctx;
  const name = command.args[0];
  if (!name) throw new UsageError('A profile name is required.');
  assertValidProfileName(name);

  const config = await loadConfig();
  if (!isKnownProfile(config, name)) {
    throw new UsageError(`No profile named "${name}".`, 'Create it first with `kite profiles add`.');
  }

  // Storing the reserved default as the pointer is just noise; clearing it says
  // the same thing.
  const next = { ...config };
  if (name === DEFAULT_PROFILE) delete next.defaultProfile;
  else next.defaultProfile = name;
  await saveConfig(next);

  const meta = await loadSessionMeta(name);
  if (io.json) {
    io.writeJson({ default_profile: name, user_id: meta?.userId ?? null });
    return;
  }

  io.success(`Default profile is now ${io.bold(name)}.`);
  // Loud, because a persisted default silently changes which account every
  // later command targets — the exact thing a multi-account user must not lose
  // track of. The identity is echoed so they can confirm it is who they meant.
  const who = meta ? `${meta.userName ?? meta.userId} (${meta.userId})` : io.dim('not logged in yet');
  io.warn(`Every command without --profile will now use ${io.bold(name)} — ${who}.`);
}

async function currentProfile(ctx: Context): Promise<void> {
  const { io, profile } = ctx;
  const meta = await loadSessionMeta(profile.name);

  if (io.json) {
    io.writeJson({
      profile: profile.name,
      logged_in: ctx.client.hasSession(),
      user_id: meta?.userId ?? null,
    });
    return;
  }

  io.line(
    renderKeyValue(io, [
      ['Profile', profile.name === DEFAULT_PROFILE ? profile.name : io.bold(profile.name)],
      ['API key', profile.apiKey ? io.green('set') : io.dim('not set')],
      [
        'Session',
        !ctx.client.hasSession()
          ? io.dim('not logged in')
          : meta
            ? `${meta.userName ?? meta.userId} (${meta.userId}), expires in ${timeUntilExpiry(meta)}`
            : 'token from environment',
      ],
    ]),
  );
}

/** A yes/no gate that respects --yes and refuses (rather than proceeds) without a TTY. */
async function confirmDestructive(ctx: Context, message: string): Promise<void> {
  if (ctx.options.yes) return;
  if (!process.stdin.isTTY || !ctx.io.stderrIsTty) {
    throw new KiteCliError(
      `${message} needs confirmation, but this is not an interactive terminal.`,
      ExitCode.ConfirmationRequired,
      'Pass --yes to confirm non-interactively.',
    );
  }
  const answer = await confirm({ message, initialValue: false });
  if (isCancel(answer) || answer !== true) throw new AbortedError();
}
