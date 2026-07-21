import logUpdate from 'log-update';
import { Ticker, MAX_INSTRUMENTS_PER_CONNECTION, type Tick, type TickerMode } from '../core/ticker.js';
import { getSecret } from '../core/credentials.js';
import { parseInstrumentKey, formatInstrumentKey } from '../core/instruments.js';
import { UsageError, KiteCliError, ExitCode } from '../core/errors.js';
import { renderTable, type Column } from '../output/table.js';
import { money, percent, compactNumber, timeOnly } from '../output/format.js';
import type { Context } from '../context.js';
import type { CommandFactory } from './types.js';

/**
 * Live streaming quotes.
 *
 * Two design choices worth stating, both about not melting the terminal:
 *
 *  1. **Tick rate is decoupled from render rate.** Kite pushes far faster than
 *     a human can read. Ticks accumulate into a map and we repaint on a fixed
 *     interval (default 4/sec). Rendering per tick would burn CPU and produce
 *     an unreadable blur.
 *
 *  2. **The visible row count is capped below the terminal height.** When a
 *     live-updating region grows taller than the terminal, the renderer is
 *     forced into full-screen repaints and flicker becomes very hard to
 *     eliminate. Staying under the fold avoids the problem entirely rather
 *     than fighting it.
 */
export const watchCommands: CommandFactory = (program, run) => {
  program
    .command('watch')
    .description('Stream live quotes in a self-updating table')
    .argument('[instruments...]', 'Instruments to watch, e.g. NSE:INFY NSE:TCS')
    .option('--holdings', 'Watch everything in your holdings')
    .option('--positions', 'Watch your open positions')
    .option('-m, --mode <mode>', 'Streaming mode: ltp, quote, or full', 'quote')
    .option('--fps <n>', 'Screen repaints per second', '4')
    .option('--orders', 'Also print live order updates')
    .action(run(watch));
};

async function watch(
  ctx: Context,
  opts: { holdings?: boolean; positions?: boolean; mode?: string; fps?: string; orders?: boolean },
  command: { args: string[] },
): Promise<void> {
  ctx.requireSession();

  const mode = (opts.mode ?? 'quote').toLowerCase();
  if (mode !== 'ltp' && mode !== 'quote' && mode !== 'full') {
    throw new UsageError('--mode must be ltp, quote, or full.');
  }

  // --- resolve the watchlist ---------------------------------------------
  const keys = new Set<string>();
  for (const arg of command.args) {
    const parsed = parseInstrumentKey(arg);
    keys.add(formatInstrumentKey(parsed.exchange, parsed.tradingsymbol));
  }
  if (opts.holdings) {
    for (const holding of await ctx.api.getHoldings(ctx.signal)) {
      keys.add(formatInstrumentKey(holding.exchange, holding.tradingsymbol));
    }
  }
  if (opts.positions) {
    const positions = await ctx.api.getPositions(ctx.signal);
    for (const position of positions.net) {
      if (position.quantity !== 0) {
        keys.add(formatInstrumentKey(position.exchange, position.tradingsymbol));
      }
    }
  }

  if (keys.size === 0) {
    throw new UsageError(
      'Nothing to watch.',
      'Pass instruments (e.g. `kite watch NSE:INFY`), or use --holdings / --positions.',
    );
  }
  if (keys.size > MAX_INSTRUMENTS_PER_CONNECTION) {
    throw new UsageError(
      `Kite allows at most ${MAX_INSTRUMENTS_PER_CONNECTION} instruments per connection; you asked for ${keys.size}.`,
    );
  }

  // The WebSocket accepts ONLY numeric instrument tokens, never symbols.
  await ctx.instruments.load({ signal: ctx.signal });
  const watchlist: Array<{ key: string; token: number }> = [];
  for (const key of keys) {
    watchlist.push({ key, token: ctx.instruments.requireToken(key) });
  }
  const tokenToKey = new Map(watchlist.map((entry) => [entry.token, entry.key]));

  // --- credentials for the socket ----------------------------------------
  const stored = await getSecret('access_token', { env: ctx.env });
  if (!stored) {
    throw new KiteCliError('No access token available for streaming.', ExitCode.Auth, 'Run `kite login`.');
  }

  const ticker = new Ticker({
    apiKey: ctx.client.apiKey,
    accessToken: stored.value,
    endpoints: ctx.endpoints,
    // The sandbox socket will not authenticate without a user_id, which the
    // official SDKs do not send.
    userId: ctx.env === 'sandbox' ? ctx.session?.userId : undefined,
  });

  // --- JSON mode: stream NDJSON, no dashboard ----------------------------
  if (ctx.io.json || !ctx.io.interactive) {
    await streamJson(ctx, ticker, watchlist, tokenToKey, mode as TickerMode, opts.orders ?? false);
    return;
  }

  await streamDashboard(ctx, ticker, watchlist, tokenToKey, mode as TickerMode, opts);
}

/** Non-TTY / --json: one JSON object per line, suitable for piping. */
async function streamJson(
  ctx: Context,
  ticker: Ticker,
  watchlist: Array<{ key: string; token: number }>,
  tokenToKey: Map<number, string>,
  mode: TickerMode,
  showOrders: boolean,
): Promise<void> {
  ticker.on('ticks', (ticks) => {
    for (const tick of ticks) {
      ctx.io.writeJson({ ...tick, instrument: tokenToKey.get(tick.instrumentToken) });
    }
  });
  if (showOrders) {
    ticker.on('orderUpdate', (order) => ctx.io.writeJson({ type: 'order', data: order }));
  }
  ticker.on('connect', () => ticker.subscribe(watchlist.map((w) => w.token), mode));

  // An EventEmitter with no 'error' listener RETHROWS the error, which here
  // would escape the socket callback and take the process down mid-stream.
  // Errors are recoverable — the ticker reconnects — so report and continue.
  ticker.on('error', (err) => ctx.io.warn(err.message));
  ticker.on('reconnect', ({ attempt, delayMs }) =>
    ctx.io.warn(`Disconnected; reconnecting (attempt ${attempt}, ${Math.round(delayMs / 1000)}s)…`),
  );

  // Without this the reconnect budget can be exhausted while the command sits
  // waiting on a signal that will never arrive, hanging a pipeline forever.
  const exhausted = new Promise<void>((resolve) => {
    ticker.once('noreconnect', () => {
      ctx.io.error('Gave up reconnecting to the Kite ticker.');
      process.exitCode = ExitCode.Upstream;
      resolve();
    });
  });

  ticker.connect();

  await Promise.race([waitForSignal(ctx.signal), exhausted]);
  ticker.close();
}

async function streamDashboard(
  ctx: Context,
  ticker: Ticker,
  watchlist: Array<{ key: string; token: number }>,
  tokenToKey: Map<number, string>,
  mode: TickerMode,
  opts: { fps?: string; orders?: boolean },
): Promise<void> {
  const { io } = ctx;

  const fps = clamp(Number(opts.fps ?? 4) || 4, 1, 20);
  const latest = new Map<number, Tick>();
  const previousPrice = new Map<number, number>();
  const flashUntil = new Map<number, { direction: 1 | -1; at: number }>();
  const orderLog: string[] = [];

  let status = 'connecting…';
  let lastUpdate: Date | undefined;

  ticker.on('connect', () => {
    status = 'live';
    ticker.subscribe(watchlist.map((w) => w.token), mode);
  });
  ticker.on('reconnect', ({ attempt, delayMs }) => {
    status = `reconnecting (attempt ${attempt}, ${Math.round(delayMs / 1000)}s)`;
  });
  ticker.on('close', () => {
    if (status === 'live') status = 'disconnected';
  });
  ticker.on('noreconnect', () => {
    status = 'gave up reconnecting';
  });
  ticker.on('error', (err) => {
    status = `error: ${err.message}`;
  });

  ticker.on('ticks', (ticks) => {
    // Buffer only — the render loop decides when to paint.
    for (const tick of ticks) {
      const previous = latest.get(tick.instrumentToken);
      if (previous && previous.lastPrice !== tick.lastPrice) {
        previousPrice.set(tick.instrumentToken, previous.lastPrice);
        flashUntil.set(tick.instrumentToken, {
          direction: tick.lastPrice > previous.lastPrice ? 1 : -1,
          at: Date.now(),
        });
      }
      latest.set(tick.instrumentToken, tick);
    }
    lastUpdate = new Date();
  });

  if (opts.orders) {
    ticker.on('orderUpdate', (payload) => {
      const order = payload as { tradingsymbol?: string; status?: string; filled_quantity?: number };
      orderLog.unshift(
        `${timeOnly(new Date())}  ${order.tradingsymbol ?? '?'}  ${order.status ?? '?'}  ${order.filled_quantity ?? 0} filled`,
      );
      orderLog.length = Math.min(orderLog.length, 5);
    });
  }

  // Cap rows so the live region never exceeds the terminal height — this is
  // what keeps the repaint incremental instead of full-screen.
  const chromeRows = 6 + (opts.orders ? 7 : 0);
  const maxRows = Math.max(3, io.rows - chromeRows);
  const visible = watchlist.slice(0, maxRows);
  const hidden = watchlist.length - visible.length;

  const render = () => {
    const now = Date.now();
    const rows = visible.map((entry) => ({
      key: entry.key,
      tick: latest.get(entry.token),
      flash: flashUntil.get(entry.token),
    }));

    const columns: Array<Column<(typeof rows)[number]>> = [
      { header: 'Instrument', value: (r, io) => io.bold(r.key) },
      {
        header: 'LTP',
        value: (r, io) => {
          if (!r.tick) return io.dim('—');
          const text = money(r.tick.lastPrice);
          // Flash the cell briefly on a price change so movement is visible
          // even when the number barely shifts.
          if (r.flash && now - r.flash.at < 400) {
            return r.flash.direction === 1 ? io.green(text) : io.red(text);
          }
          return text;
        },
        align: 'right',
      },
      {
        header: 'Change',
        value: (r, io) => (r.tick?.change === undefined ? io.dim('—') : io.signed(r.tick.change, percent(r.tick.change))),
        align: 'right',
      },
      { header: 'Open', value: (r) => money(r.tick?.ohlc?.open), align: 'right' },
      { header: 'High', value: (r) => money(r.tick?.ohlc?.high), align: 'right' },
      { header: 'Low', value: (r) => money(r.tick?.ohlc?.low), align: 'right' },
      { header: 'Close', value: (r) => money(r.tick?.ohlc?.close), align: 'right' },
      ...(mode !== 'ltp'
        ? [
            {
              header: 'Volume',
              value: (r: (typeof rows)[number]) => compactNumber(r.tick?.volume),
              align: 'right' as const,
            },
          ]
        : []),
    ];

    const statusColour =
      status === 'live' ? io.green('● live') : status.startsWith('error') ? io.red(`● ${status}`) : io.yellow(`● ${status}`);

    const parts = [
      `${statusColour}  ${io.dim(`${watchlist.length} instruments · ${mode} mode · ${lastUpdate ? timeOnly(lastUpdate) : 'waiting for data'}`)}`,
      renderTable(io, rows, columns, { compact: ctx.config.output.compact }),
    ];

    if (hidden > 0) {
      parts.push(io.dim(`  …and ${hidden} more (terminal too short to show them all)`));
    }
    if (opts.orders && orderLog.length > 0) {
      parts.push(`\n${io.bold('Order updates')}\n${orderLog.map((line) => `  ${io.dim(line)}`).join('\n')}`);
    }
    parts.push(io.dim('\n  Ctrl-C to stop'));

    logUpdate(parts.join('\n'));
  };

  // The dashboard already listens for 'error', so the emitter never rethrows.
  // It still needs to stop waiting once reconnection is abandoned.
  const exhausted = new Promise<void>((resolve) => {
    ticker.once('noreconnect', () => {
      process.exitCode = ExitCode.Upstream;
      resolve();
    });
  });

  ticker.connect();
  const timer = setInterval(render, Math.round(1000 / fps));
  render();

  try {
    await Promise.race([waitForSignal(ctx.signal), exhausted]);
  } finally {
    clearInterval(timer);
    ticker.close();
    // Leave the final frame on screen rather than erasing it.
    logUpdate.done();
  }
}

function waitForSignal(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
