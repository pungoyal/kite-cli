import type { Context } from '../context.js';
import { redirectUrlFor } from '../core/auth.js';
import { ConfigSchema, isSettableKey, loadConfig, SETTABLE_KEYS, saveConfig } from '../core/config.js';
import { getSecret, keyringAvailable } from '../core/credentials.js';
import { UsageError } from '../core/errors.js';
import { cacheDir, configDir, configFile } from '../core/paths.js';
import { maskSecret } from '../core/redact.js';
import { rupees } from '../output/format.js';
import { heading, renderKeyValue } from '../output/table.js';
import type { CommandFactory } from './types.js';

export const configCommands: CommandFactory = (program, run) => {
  const config = program.command('config').description('View and change CLI settings');

  config.command('show', { isDefault: true }).description('Show the current configuration').action(run(showConfig));

  config
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Dotted key, e.g. trading.maxOrderValue')
    .argument('<value>')
    .action(run(setConfig));

  config
    .command('unset')
    .description('Remove a configuration value, restoring its default')
    .argument('<key>')
    .action(run(unsetConfig));

  config.command('path').description('Print the paths this CLI reads and writes').action(run(showPaths));
};

async function showConfig(ctx: Context): Promise<void> {
  const { io } = ctx;
  const config = await loadConfig();

  if (io.json) {
    io.writeJson(config);
    return;
  }

  const secret = await getSecret('api_secret', { scope: ctx.credentialScope });
  // Effective trading config for the active profile (global overlaid with the
  // profile's overrides), so this view matches what a money-moving command sees.
  const trading = ctx.config.trading;

  io.line(heading(io, 'Account'));
  io.line(
    renderKeyValue(io, [
      ['Profile', ctx.profile.name === 'default' ? ctx.profile.name : io.bold(ctx.profile.name)],
      ['API key', ctx.profile.apiKey || io.dim('not set')],
      ['API secret', secret ? `${maskSecret(secret.value)} (${secret.backend})` : io.dim('not set')],
      [
        'Keyring',
        (await keyringAvailable()) ? io.green('available') : io.yellow('unavailable — using an encrypted file'),
      ],
    ]),
  );

  io.line(heading(io, 'Trading safety'));
  io.line(
    renderKeyValue(io, [
      ['Trading enabled', trading.enabled ? io.green('yes') : io.red('no — all order commands will refuse')],
      ['Confirm orders', trading.confirm ? 'yes' : io.yellow('no')],
      ['Max order value', trading.maxOrderValue ? rupees(trading.maxOrderValue) : io.dim('no cap')],
      ['Strict confirm above', rupees(trading.strictConfirmAbove)],
    ]),
  );

  const others = Object.keys(config.profiles);
  if (others.length > 0) {
    io.line(heading(io, 'Profiles'));
    io.line(renderKeyValue(io, [['Configured', ['default', ...others].join(', ')]]));
    io.note(io.dim('  Manage them with `kite profiles`.'));
  }

  io.line(heading(io, 'Login callback'));
  io.line(
    renderKeyValue(io, [
      ['Redirect URL', redirectUrlFor(config.redirectPort, config.redirectPath)],
      ['', io.dim('This must match the redirect URL in your Kite developer console exactly.')],
    ]),
  );

  io.line(heading(io, 'Output'));
  io.line(
    renderKeyValue(io, [
      ['Colour', config.output.color],
      ['Compact tables', config.output.compact ? 'yes' : 'no'],
    ]),
  );

  io.note('');
  io.info(`Config file: ${configFile()}`);
}

/**
 * Values arrive from argv as strings, so they are coerced by inspecting the
 * default for that key, then re-validated through the full schema. That way an
 * invalid value is rejected before it is written, rather than breaking every
 * later invocation.
 */
async function setConfig(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  const [key, rawValue] = command.args;
  if (!key || rawValue === undefined) {
    throw new UsageError('Both a key and a value are required, e.g. `kite config set trading.enabled false`.');
  }

  if (!isSettableKey(key)) {
    const available = Object.keys(SETTABLE_KEYS).join(', ');
    throw new UsageError(`Unknown setting "${key}".`, `Available settings: ${available}.`);
  }

  const config = await loadConfig();
  const coerced = coerce(rawValue, SETTABLE_KEYS[key].type, key);
  const updated = structuredClone(config) as Record<string, unknown>;

  const target = ctx.profile.name;
  if (target === 'default') {
    writePath(updated, key, coerced);
  } else {
    // Only account- and trading-scoped keys make sense per profile; global
    // presentation/callback settings would be silently ignored, so refuse them.
    if (!isProfileScopedKey(key)) {
      throw new UsageError(`"${key}" is a global setting.`, 'Drop --profile to set it globally.');
    }
    const profiles = (updated.profiles ?? {}) as Record<string, Record<string, unknown>>;
    updated.profiles = profiles;
    const entry = (profiles[target] ?? {}) as Record<string, unknown>;
    profiles[target] = entry;
    writePath(entry, key, coerced);
  }

  const parsed = ConfigSchema.safeParse(updated);
  if (!parsed.success) {
    const { z } = await import('zod');
    throw new UsageError(`Invalid value for "${key}":\n${z.prettifyError(parsed.error)}`);
  }

  await saveConfig(parsed.data);

  if (ctx.io.json) {
    ctx.io.writeJson({ key, value: coerced, profile: target });
    return;
  }
  const onProfile = target === 'default' ? '' : ` on profile ${ctx.io.bold(target)}`;
  ctx.io.success(`Set ${ctx.io.bold(key)} to ${JSON.stringify(coerced)}${onProfile}.`);

  if (key === 'trading.enabled' && coerced === false) {
    ctx.io.info('The kill switch is on. All order commands will now refuse before contacting Kite.');
  }
  if (key === 'redirectPort' || key === 'redirectPath') {
    const next = await loadConfig();
    ctx.io.info(`Update your Kite app's redirect URL to ${redirectUrlFor(next.redirectPort, next.redirectPath)}`);
  }
}

async function unsetConfig(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  const key = command.args[0];
  if (!key) throw new UsageError('A key is required.');
  if (!isSettableKey(key)) {
    throw new UsageError(`Unknown setting "${key}".`, `Available settings: ${Object.keys(SETTABLE_KEYS).join(', ')}.`);
  }

  const config = await loadConfig();
  const updated = structuredClone(config) as Record<string, unknown>;

  const target = ctx.profile.name;
  if (target === 'default') {
    deletePath(updated, key);
  } else {
    if (!isProfileScopedKey(key)) {
      throw new UsageError(`"${key}" is a global setting.`, 'Drop --profile to unset it globally.');
    }
    const profiles = (updated.profiles ?? {}) as Record<string, Record<string, unknown>>;
    const entry = profiles[target];
    if (entry) deletePath(entry, key);
  }

  const parsed = ConfigSchema.safeParse(updated);
  if (!parsed.success) {
    const { z } = await import('zod');
    throw new UsageError(`Cannot unset "${key}":\n${z.prettifyError(parsed.error)}`);
  }

  await saveConfig(parsed.data);
  if (ctx.io.json) {
    ctx.io.writeJson({ key, unset: true, profile: target });
    return;
  }
  const onProfile = target === 'default' ? '' : ` on profile ${ctx.io.bold(target)}`;
  ctx.io.success(`Unset ${ctx.io.bold(key)}${onProfile}.`);
}

async function showPaths(ctx: Context): Promise<void> {
  const { io } = ctx;
  const paths = {
    config: configFile(),
    configDir: configDir(),
    cacheDir: cacheDir(),
  };

  if (io.json) {
    io.writeJson(paths);
    return;
  }

  io.line(
    renderKeyValue(io, [
      ['Config file', paths.config],
      ['Config directory', paths.configDir],
      ['Cache directory', paths.cacheDir],
      ['Secrets', (await keyringAvailable()) ? 'OS keyring' : `${paths.configDir}/credentials.enc`],
    ]),
  );
}

// ---------------------------------------------------------------------------

/** Keys that mean something per profile; the rest are global (output, callback). */
function isProfileScopedKey(key: string): boolean {
  return key === 'apiKey' || key.startsWith('trading.');
}

/** Coerce an argv string to the type the setting declares. */
function coerce(raw: string, type: 'string' | 'number' | 'boolean', key: string): unknown {
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new UsageError(`${key} expects true or false, got "${raw}".`);
  }
  if (type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new UsageError(`${key} expects a number, got "${raw}".`);
    return n;
  }
  return raw;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop()!;
  let node = target;
  for (const segment of segments) {
    if (typeof node[segment] !== 'object' || node[segment] === null) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[last] = value;
}

function deletePath(target: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  const last = segments.pop()!;
  let node = target;
  for (const segment of segments) {
    const next = node[segment];
    if (typeof next !== 'object' || next === null) return;
    node = next as Record<string, unknown>;
  }
  delete node[last];
}
