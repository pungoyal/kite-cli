import { loadConfig, saveConfig, ConfigSchema, SETTABLE_KEYS, isSettableKey } from '../core/config.js';
import { configFile, configDir, cacheDir } from '../core/paths.js';
import { keyringAvailable, getSecret } from '../core/credentials.js';
import { redirectUrlFor } from '../core/auth.js';
import { maskSecret } from '../core/redact.js';
import { UsageError } from '../core/errors.js';
import { renderKeyValue, heading } from '../output/table.js';
import { rupees } from '../output/format.js';
import type { Context } from '../context.js';
import type { CommandFactory } from './types.js';

export const configCommands: CommandFactory = (program, run) => {
  const config = program.command('config').description('View and change CLI settings');

  config
    .command('show', { isDefault: true })
    .description('Show the current configuration')
    .action(run(showConfig));

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

  config
    .command('path')
    .description('Print the paths this CLI reads and writes')
    .action(run(showPaths));
};

async function showConfig(ctx: Context): Promise<void> {
  const { io } = ctx;
  const config = await loadConfig();

  if (io.json) {
    io.writeJson(config);
    return;
  }

  const secret = await getSecret('api_secret', { env: ctx.env });

  io.line(heading(io, 'Account'));
  io.line(
    renderKeyValue(io, [
      ['API key', config.apiKey ?? io.dim('not set')],
      ['API secret', secret ? `${maskSecret(secret.value)} (${secret.backend})` : io.dim('not set')],
      ['Environment', config.env === 'sandbox' ? io.cyan('sandbox') : 'production'],
      ['Keyring', (await keyringAvailable()) ? io.green('available') : io.yellow('unavailable — using an encrypted file')],
    ]),
  );

  io.line(heading(io, 'Trading safety'));
  io.line(
    renderKeyValue(io, [
      [
        'Trading enabled',
        config.trading.enabled ? io.green('yes') : io.red('no — all order commands will refuse'),
      ],
      ['Confirm orders', config.trading.confirm ? 'yes' : io.yellow('no')],
      ['Max order value', config.trading.maxOrderValue ? rupees(config.trading.maxOrderValue) : io.dim('no cap')],
      ['Strict confirm above', rupees(config.trading.strictConfirmAbove)],
    ]),
  );

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
  writePath(updated, key, coerced);

  const parsed = ConfigSchema.safeParse(updated);
  if (!parsed.success) {
    const { z } = await import('zod');
    throw new UsageError(`Invalid value for "${key}":\n${z.prettifyError(parsed.error)}`);
  }

  await saveConfig(parsed.data);

  if (ctx.io.json) {
    ctx.io.writeJson({ key, value: coerced });
    return;
  }
  ctx.io.success(`Set ${ctx.io.bold(key)} to ${JSON.stringify(coerced)}.`);

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
    throw new UsageError(
      `Unknown setting "${key}".`,
      `Available settings: ${Object.keys(SETTABLE_KEYS).join(', ')}.`,
    );
  }

  const config = await loadConfig();
  const updated = structuredClone(config) as Record<string, unknown>;
  deletePath(updated, key);

  const parsed = ConfigSchema.safeParse(updated);
  if (!parsed.success) {
    const { z } = await import('zod');
    throw new UsageError(`Cannot unset "${key}":\n${z.prettifyError(parsed.error)}`);
  }

  await saveConfig(parsed.data);
  if (ctx.io.json) {
    ctx.io.writeJson({ key, unset: true });
    return;
  }
  ctx.io.success(`Unset ${ctx.io.bold(key)}.`);
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

function readPath(target: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, segment) => {
    if (node && typeof node === 'object' && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, target);
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
