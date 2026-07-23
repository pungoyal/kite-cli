import type { Command } from 'commander';
import type { Runner } from './types.js';

/**
 * Command wiring, factored out of run.ts so there is a single source of truth
 * for the command tree.
 *
 * run() consumes this to build the live program; `kite completion` consumes it
 * with a no-op runner to introspect command and flag names for shell
 * completions. Keeping both on the same registration path means a new command
 * or flag is completable the moment it is added, with nothing to keep in sync.
 */

/**
 * Attach the global options every command inherits. Split from the name /
 * version / output wiring in run.ts, which is invocation-specific, so an
 * introspection-only program can still enumerate the same global flags.
 */
export function applyGlobalOptions(program: Command): Command {
  return (
    program
      .option('--json', 'Emit JSON instead of formatted tables')
      .option('--color <when>', 'Colour output: auto, always, or never')
      // Deliberately no `-q` short form: it would shadow `-q, --quantity` on the
      // order and GTT subcommands, which is typed far more often than --quiet.
      .option('--quiet', 'Suppress informational messages')
      .option('--debug', 'Print redacted request diagnostics to stderr')
      .option('--profile <name>', 'Account profile to use (see `kite profiles`)')
      .option('-y, --yes', 'Skip confirmation prompts (use with care)')
      .option('--dry-run', 'Show what would happen without sending anything to Kite')
  );
}

/**
 * Register every command group on `program`, grouped for a readable `--help`.
 *
 * The `run` runner wraps each handler with context construction and error
 * reporting in the real CLI; completion passes a no-op that only needs the
 * command definitions, not their behaviour.
 */
export async function registerCommands(program: Command, run: Runner): Promise<void> {
  // Imported here rather than at module top so a single invocation only pays for
  // parsing the command modules once run() (or completion) actually asks for
  // them, not on every `import` of this file.
  const { authCommands } = await import('./auth.js');
  const { profileCommands } = await import('./profiles.js');
  const { portfolioCommands } = await import('./portfolio.js');
  const { marketCommands } = await import('./market.js');
  const { orderCommands } = await import('./orders.js');
  const { gttCommands } = await import('./gtt.js');
  const { alertCommands } = await import('./alerts.js');
  const { marginCommands } = await import('./margins.js');
  const { mfCommands } = await import('./mf.js');
  const { watchCommands } = await import('./watch.js');
  const { configCommands } = await import('./config.js');
  const { doctorCommands } = await import('./doctor.js');
  const { completionCommands } = await import('./completion.js');
  const { mcpCommands } = await import('./mcp.js');

  // commandsGroup applies to every command registered after it, so the group
  // is set immediately before each block. With ~25 commands this is the
  // difference between a readable --help and a wall of text.
  program.commandsGroup('Account:');
  authCommands(program, run);
  profileCommands(program, run);

  program.commandsGroup('Portfolio:');
  portfolioCommands(program, run);

  program.commandsGroup('Mutual funds:');
  mfCommands(program, run);

  program.commandsGroup('Market data:');
  marketCommands(program, run);

  program.commandsGroup('Trading:');
  orderCommands(program, run);
  gttCommands(program, run);
  alertCommands(program, run);
  marginCommands(program, run);

  program.commandsGroup('Streaming:');
  watchCommands(program, run);

  program.commandsGroup('Integrations:');
  mcpCommands(program, run);

  program.commandsGroup('Settings:');
  configCommands(program, run);
  doctorCommands(program, run);
  completionCommands(program, run);
}
