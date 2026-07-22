import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { applyGlobalOptions, registerCommands } from './commands/register.js';
import type { Handler } from './commands/types.js';
import { createContext, type GlobalOptions } from './context.js';
import { AbortedError, ExitCode, type ExitCodeValue, KiteCliError } from './core/errors.js';
import { redactString } from './core/redact.js';
import { Io, type IoStreams } from './output/io.js';

export interface RunOptions {
  argv?: string[];
  streams?: IoStreams;
}

// Read from package.json so `npm version` is the single source of truth and
// `kite --version` can never drift. `../package.json` resolves to the package
// root from source (tests) and from dist/ (published), since package.json always
// ships with the package.
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

/**
 * Build and execute the CLI.
 *
 * Exported as a function taking argv and streams (rather than reading
 * process.argv directly) so tests can drive it in-process. That matters
 * because HTTP mocking cannot reach into a spawned child process — most tests
 * call this, and only a thin smoke layer spawns the real binary.
 */
export async function run(opts: RunOptions = {}): Promise<ExitCodeValue> {
  const argv = opts.argv ?? process.argv;

  // Handlers signal partial failure by setting process.exitCode (e.g. a sliced
  // order where some legs succeeded). That is a process global, so reset it on
  // entry — otherwise a second run() in the same process inherits the first
  // run's failure. Matters for tests and for any embedder.
  process.exitCode = undefined;

  // Ctrl-C cancels in-flight requests rather than leaving them dangling.
  const controller = new AbortController();
  const onSigint = () => controller.abort(new AbortedError('Interrupted.'));
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigint);

  const program = new Command();
  let exitCode: ExitCodeValue = ExitCode.Ok;

  program
    .name('kite')
    .description('Unofficial, safety-first CLI for the Zerodha Kite Connect v3 API (not affiliated with Zerodha)')
    .version(VERSION, '-v, --version')
    .showHelpAfterError('(run `kite --help` for usage)')
    .configureOutput({
      writeOut: (str) => (opts.streams?.stdout ?? process.stdout).write(str),
      writeErr: (str) => (opts.streams?.stderr ?? process.stderr).write(str),
    })
    // Throw instead of calling process.exit, so `run()` stays testable and
    // always returns its exit code.
    .exitOverride();

  applyGlobalOptions(program);

  /** Wraps a handler with context construction and error reporting. */
  const withContext =
    <Options>(handler: Handler<Options>) =>
    async (...args: unknown[]): Promise<void> => {
      // Commander passes (…arguments, options, command).
      const command = args[args.length - 1] as Command;
      const options = args[args.length - 2] as Options;
      const globals = program.opts<GlobalOptions>();

      const ctx = await createContext(globals, controller.signal, opts.streams);
      try {
        await handler(ctx, options, command);
      } catch (err) {
        exitCode = reportError(err, ctx.io);
      }
    };

  // Registered through the shared registration path (see commands/register.ts)
  // so run() and `kite completion` build the exact same command tree. Modules
  // are still imported lazily inside registerCommands, so a bare `kite quote`
  // never pays to parse the dashboard renderer or the ticker up front.
  await registerCommands(program, withContext);

  program.addHelpText(
    'after',
    `
Examples:
  $ kite login                                  Authenticate and store a session
  $ kite holdings                               Show your portfolio
  $ kite quote NSE:INFY NSE:TCS                 Live quotes for two symbols
  $ kite watch --holdings                       Stream your whole portfolio
  $ kite history NSE:INFY -i 5minute --from 7d  Recent 5-minute candles
  $ kite orders place NSE:INFY -s BUY -q 1 --dry-run
                                                Preview an order without sending it
  $ kite positions --json | jq '.net[].pnl'     Machine-readable output
  $ kite --profile huf holdings                 Run against another account (kite profiles)

Safety:
  Order commands preview the resolved order and ask for confirmation.
  Use --dry-run to validate without sending, or --yes to skip the prompt.
  Disable trading entirely with: kite config set trading.enabled false
`,
  );

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help and --version are reported as errors by exitOverride.
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help' || err.code === 'commander.version') {
        return ExitCode.Ok;
      }
      return ExitCode.Usage;
    }
    const io = new Io({ ...(opts.streams ? { streams: opts.streams } : {}) });
    exitCode = reportError(err, io);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigint);
  }

  // A handler may have set process.exitCode directly (e.g. a partially failed
  // sliced order), which should win over a clean return.
  if (exitCode === ExitCode.Ok && typeof process.exitCode === 'number' && process.exitCode !== 0) {
    return process.exitCode as ExitCodeValue;
  }
  return exitCode;
}

/**
 * Render an error and choose an exit code.
 *
 * Every message is redacted before printing: an API error can echo back input
 * that contains a token, and a stack trace can contain the WebSocket URL.
 */
function reportError(err: unknown, io: Io): ExitCodeValue {
  if (err instanceof AbortedError) {
    io.note('');
    io.error(err.message);
    return err.exitCode;
  }

  if (err instanceof KiteCliError) {
    io.error(redactString(err.message));
    if (err.hint) io.note(`  ${io.dim(err.hint)}`);
    return err.exitCode;
  }

  if (err instanceof Error && err.name === 'AbortError') {
    io.error('Interrupted.');
    return ExitCode.Aborted;
  }

  const message = err instanceof Error ? err.message : String(err);
  io.error(redactString(message));
  if (err instanceof Error && err.stack && process.env['KITE_DEBUG_STACK'] === '1') {
    io.note(redactString(err.stack));
  } else {
    io.note(io.dim('  Set KITE_DEBUG_STACK=1 for a stack trace.'));
  }
  return ExitCode.Failure;
}
