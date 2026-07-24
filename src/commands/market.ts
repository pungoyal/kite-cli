import type { Context } from '../context.js';
import { type HistoricalInterval, MAX_DAYS_PER_REQUEST, parseInterval } from '../core/api.js';
import { UsageError } from '../core/errors.js';
import { formatInstrumentKey, parseInstrumentKey } from '../core/instruments.js';
import type { Candle, Instrument, Quote } from '../core/schemas.js';
import { compactNumber, dateTime, money, parseUserDate, percent, quantity, timeOnly } from '../output/format.js';
import { type Column, heading, printTable, renderKeyValue, renderTable } from '../output/table.js';
import { examples } from './examples.js';
import type { CommandFactory } from './types.js';

export const marketCommands: CommandFactory = (program, run) => {
  program
    .command('quote')
    .description('Show full quotes with market depth')
    .argument('<instruments...>', 'One or more instruments, e.g. NSE:INFY NSE:TCS')
    .option('--depth', 'Show the full 5-level order book')
    .addHelpText(
      'after',
      examples([
        ['kite quote NSE:INFY', 'Full quote for one instrument'],
        ['kite quote NSE:INFY NSE:TCS NSE:HDFCBANK', 'Several at once (one API call)'],
        ['kite quote NSE:INFY --depth', 'With the 5-level bid/ask book'],
        ['kite quote "INDICES:NIFTY 50"', 'An index — quote a symbol with a space'],
        ['kite quote NFO:NIFTY25AUGFUT --json', 'JSON keyed by EXCHANGE:SYMBOL'],
      ]),
    )
    .action(run(quoteCommand));

  program
    .command('ltp')
    .description('Show last traded prices (fastest quote endpoint)')
    .argument('<instruments...>', 'One or more instruments, e.g. NSE:INFY')
    .addHelpText(
      'after',
      examples([
        ['kite ltp NSE:INFY', 'Last traded price'],
        ['kite ltp NSE:INFY NSE:TCS', 'Several at once'],
        [`kite ltp NSE:INFY --json | jq '."NSE:INFY".last_price'`, 'One price, for a script'],
      ]),
    )
    .action(run(ltpCommand));

  program
    .command('ohlc')
    .description('Show open/high/low/close plus last price')
    .argument('<instruments...>', 'One or more instruments')
    .addHelpText(
      'after',
      examples([
        ['kite ohlc NSE:INFY', "Today's open/high/low/close and last price"],
        ['kite ohlc NSE:INFY NSE:TCS', 'Several at once'],
        ['kite ohlc "INDICES:NIFTY 50" --json', 'Index OHLC as JSON'],
      ]),
    )
    .action(run(ohlcCommand));

  program
    .command('history')
    .description('Fetch historical candles')
    .argument('<instrument>', 'Instrument as EXCHANGE:SYMBOL')
    .option('-i, --interval <interval>', 'Candle interval', 'day')
    .option('--from <date>', 'Start date (YYYY-MM-DD or a relative offset like 30d)', '30d')
    .option('--to <date>', 'End date (YYYY-MM-DD)', 'today')
    .option('--oi', 'Include open interest')
    .option('--continuous', 'Stitch expired contracts (futures only)')
    .option('--csv', 'Emit CSV instead of a table')
    .option('--limit <n>', 'Show only the last N candles in table view', '30')
    .addHelpText(
      'after',
      examples([
        ['kite history NSE:INFY', 'Daily candles for the last 30 days'],
        ['kite history NSE:INFY -i 5minute --from 7d', 'Intraday candles for the last week'],
        ['kite history NSE:INFY --from 2025-01-01 --to 2025-03-31 --csv > infy.csv', 'A date range, as CSV'],
        ['kite history NFO:NIFTY25AUGFUT -i 15minute --oi', 'Futures candles with open interest'],
        ['kite history NFO:NIFTY25AUGFUT --continuous', 'Stitch expired contracts into one series'],
        ['kite history NSE:INFY --limit 5', 'Show only the last 5 candles in the table'],
      ]),
    )
    .action(run(historyCommand));

  const instruments = program
    .command('instruments')
    .description('Browse the instrument master')
    .addHelpText(
      'after',
      examples([
        ['kite instruments search INFY', 'Find a tradingsymbol to use elsewhere'],
        ['kite instruments refresh', 'Re-download after expiries or new listings'],
      ]),
    );

  instruments
    .command('search')
    .description('Search instruments by symbol or name')
    .argument('<query>', 'Search text, e.g. INFY or "nifty bank"')
    .option('-e, --exchange <exchange>', 'Filter by exchange, e.g. NSE, NFO')
    .option('-t, --type <type>', 'Filter by instrument type, e.g. EQ, FUT, CE, PE')
    .option('-n, --limit <n>', 'Maximum results', '25')
    .addHelpText(
      'after',
      examples([
        ['kite instruments search INFY', 'Anything matching INFY'],
        ['kite instruments search INFY -e NSE -t EQ', 'Only the NSE equity line'],
        ['kite instruments search "nifty bank" -e NFO -t FUT', 'Bank Nifty futures contracts'],
        ['kite instruments search NIFTY -e NFO -t CE -n 50', 'Up to 50 call options'],
      ]),
    )
    .action(run(searchCommand));

  instruments
    .command('refresh')
    .description('Re-download the instrument master')
    .addHelpText(
      'after',
      examples([['kite instruments refresh', 'Refresh the cached contract list (run after expiry day)']]),
    )
    .action(run(refreshCommand));
};

async function quoteCommand(ctx: Context, opts: { depth?: boolean }, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const keys = normaliseKeys(command.args);
  const quotes = await ctx.api.getQuote(keys, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(quotes);
    return;
  }

  const { io } = ctx;
  warnAboutMissing(ctx, keys, quotes);

  const entries = keys.map((key) => [key, quotes[key]] as const).filter(([, q]) => q !== undefined);

  if (!opts.depth && entries.length > 1) {
    const rows = entries.map(([key, q]) => ({ key, quote: q! }));
    const columns: Array<Column<{ key: string; quote: Quote }>> = [
      { header: 'Instrument', value: (r, io) => io.bold(r.key) },
      {
        header: 'LTP',
        value: (r) => money(r.quote.last_price),
        align: 'right',
      },
      {
        header: 'Change',
        value: (r, io) => {
          const change = changePercent(r.quote);
          return io.signed(change ?? 0, percent(change));
        },
        align: 'right',
      },
      {
        header: 'Open',
        value: (r) => money(r.quote.ohlc?.open),
        align: 'right',
      },
      {
        header: 'High',
        value: (r) => money(r.quote.ohlc?.high),
        align: 'right',
      },
      { header: 'Low', value: (r) => money(r.quote.ohlc?.low), align: 'right' },
      {
        header: 'Close',
        value: (r) => money(r.quote.ohlc?.close),
        align: 'right',
      },
      {
        header: 'Volume',
        value: (r) => compactNumber(r.quote.volume),
        align: 'right',
      },
    ];
    io.line(renderTableOrEmpty(ctx, rows, columns));
    return;
  }

  for (const [key, quote] of entries) {
    renderQuoteDetail(ctx, key, quote!, opts.depth ?? false);
  }
}

function renderQuoteDetail(ctx: Context, key: string, quote: Quote, showDepth: boolean): void {
  const { io } = ctx;
  const change = changePercent(quote);

  io.line(heading(io, key));
  io.line(
    renderKeyValue(io, [
      ['Last price', io.bold(money(quote.last_price))],
      ['Change', io.signed(change ?? 0, `${percent(change)}  (${money(quote.net_change)})`)],
      ['Open', money(quote.ohlc?.open)],
      ['High', money(quote.ohlc?.high)],
      ['Low', money(quote.ohlc?.low)],
      ['Prev close', money(quote.ohlc?.close)],
      ['Volume', compactNumber(quote.volume)],
      ['Avg price', money(quote.average_price)],
      ['Buy qty', quantity(quote.buy_quantity)],
      ['Sell qty', quantity(quote.sell_quantity)],
      ...(quote.oi !== undefined ? ([['Open interest', compactNumber(quote.oi)]] as Array<[string, string]>) : []),
      ['Circuit', `${money(quote.lower_circuit_limit)} – ${money(quote.upper_circuit_limit)}`],
      ['Last trade', dateTime(quote.last_trade_time)],
    ]),
  );

  if (showDepth && quote.depth) {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      bid: quote.depth!.buy[i],
      ask: quote.depth!.sell[i],
    }));
    io.line('');
    io.line(
      renderTableOrEmpty(ctx, rows, [
        {
          header: 'Bid Qty',
          value: (r) => quantity(r.bid?.quantity),
          align: 'right',
        },
        {
          header: 'Orders',
          value: (r) => quantity(r.bid?.orders),
          align: 'right',
        },
        {
          header: 'Bid',
          value: (r, io) => io.green(money(r.bid?.price)),
          align: 'right',
        },
        {
          header: 'Ask',
          value: (r, io) => io.red(money(r.ask?.price)),
          align: 'right',
        },
        {
          header: 'Orders',
          value: (r) => quantity(r.ask?.orders),
          align: 'right',
        },
        {
          header: 'Ask Qty',
          value: (r) => quantity(r.ask?.quantity),
          align: 'right',
        },
      ]),
    );
  }
}

async function ltpCommand(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const keys = normaliseKeys(command.args);
  const quotes = await ctx.api.getLtp(keys, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(quotes);
    return;
  }

  warnAboutMissing(ctx, keys, quotes);
  const rows = keys
    .map((key) => ({ key, quote: quotes[key] }))
    .filter((row): row is { key: string; quote: NonNullable<typeof row.quote> } => row.quote !== undefined);

  ctx.io.line(
    renderTableOrEmpty(ctx, rows, [
      { header: 'Instrument', value: (r, io) => io.bold(r.key) },
      {
        header: 'LTP',
        value: (r) => money(r.quote.last_price),
        align: 'right',
      },
    ]),
  );
}

async function ohlcCommand(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const keys = normaliseKeys(command.args);
  const quotes = await ctx.api.getOhlc(keys, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(quotes);
    return;
  }

  warnAboutMissing(ctx, keys, quotes);
  const rows = keys
    .map((key) => ({ key, quote: quotes[key] }))
    .filter((row): row is { key: string; quote: NonNullable<typeof row.quote> } => row.quote !== undefined);

  ctx.io.line(
    renderTableOrEmpty(ctx, rows, [
      { header: 'Instrument', value: (r, io) => io.bold(r.key) },
      {
        header: 'LTP',
        value: (r) => money(r.quote.last_price),
        align: 'right',
      },
      {
        header: 'Open',
        value: (r) => money(r.quote.ohlc?.open),
        align: 'right',
      },
      {
        header: 'High',
        value: (r) => money(r.quote.ohlc?.high),
        align: 'right',
      },
      { header: 'Low', value: (r) => money(r.quote.ohlc?.low), align: 'right' },
      {
        header: 'Close',
        value: (r) => money(r.quote.ohlc?.close),
        align: 'right',
      },
      {
        header: 'Change',
        value: (r, io) => {
          const close = r.quote.ohlc?.close ?? 0;
          const change = close === 0 ? undefined : ((r.quote.last_price - close) / close) * 100;
          return io.signed(change ?? 0, percent(change));
        },
        align: 'right',
      },
    ]),
  );
}

async function historyCommand(
  ctx: Context,
  opts: {
    interval?: string;
    from?: string;
    to?: string;
    oi?: boolean;
    continuous?: boolean;
    csv?: boolean;
    limit?: string;
  },
  command: { args: string[] },
): Promise<void> {
  ctx.requireSession();

  const key = command.args[0];
  if (!key) throw new UsageError('An instrument is required, e.g. `kite history NSE:INFY`.');

  const interval = parseInterval(opts.interval ?? 'day');
  const from = parseUserDate(opts.from ?? '30d');
  const to = parseUserDate(opts.to ?? 'today');
  if (!from) throw new UsageError(`Could not parse --from "${opts.from}".`);
  if (!to) throw new UsageError(`Could not parse --to "${opts.to}".`);

  await ctx.instruments.load({ signal: ctx.signal });
  // Historical data accepts ONLY the numeric instrument token, never a symbol.
  const token = ctx.instruments.requireToken(key);

  const spanDays = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  const perRequest = MAX_DAYS_PER_REQUEST[interval];
  if (spanDays > perRequest && !ctx.io.json) {
    const requests = Math.ceil(spanDays / perRequest);
    ctx.io.info(
      `Range spans ${spanDays} days; Kite allows ${perRequest} per request at ${interval}. ` +
        `Fetching in ${requests} chunks (rate limited to 3/sec).`,
    );
  }

  const candles = await ctx.api.getHistorical(
    {
      instrument_token: token,
      interval,
      from,
      to,
      oi: opts.oi ?? false,
      continuous: opts.continuous ?? false,
    },
    ctx.signal,
  );

  if (ctx.io.json) {
    ctx.io.writeJson({
      instrument: key,
      instrument_token: token,
      interval,
      candles,
    });
    return;
  }

  if (opts.csv) {
    ctx.io.line(`timestamp,open,high,low,close,volume${opts.oi ? ',oi' : ''}`);
    for (const candle of candles) {
      ctx.io.line(candle.join(','));
    }
    return;
  }

  const limit = Number(opts.limit ?? 30);
  const shown = Number.isFinite(limit) && limit > 0 ? candles.slice(-limit) : candles;

  const columns: Array<Column<Candle>> = [
    { header: 'Date', value: (c) => formatCandleTime(c[0], interval) },
    { header: 'Open', value: (c) => money(c[1]), align: 'right' },
    { header: 'High', value: (c) => money(c[2]), align: 'right' },
    { header: 'Low', value: (c) => money(c[3]), align: 'right' },
    {
      header: 'Close',
      value: (c, io) => io.signed(c[4] - c[1], money(c[4])),
      align: 'right',
    },
    { header: 'Volume', value: (c) => compactNumber(c[5]), align: 'right' },
    ...(opts.oi
      ? [
          {
            header: 'OI',
            value: (c: Candle) => compactNumber(c[6]),
            align: 'right' as const,
          },
        ]
      : []),
  ];

  ctx.io.line(renderTableOrEmpty(ctx, shown, columns));
  if (candles.length > shown.length) {
    ctx.io.info(`Showing the last ${shown.length} of ${candles.length} candles. Use --limit 0 for all, or --csv.`);
  }
}

function formatCandleTime(timestamp: string, interval: HistoricalInterval): string {
  return interval === 'day' ? timestamp.slice(0, 10) : `${timestamp.slice(0, 10)} ${timeOnly(timestamp)}`;
}

async function searchCommand(
  ctx: Context,
  opts: { exchange?: string; type?: string; limit?: string },
  command: { args: string[] },
): Promise<void> {
  ctx.requireSession();
  const query = command.args.join(' ');

  await ctx.instruments.load({ signal: ctx.signal });
  const results = ctx.instruments.search(query, {
    exchange: opts.exchange?.toUpperCase(),
    type: opts.type?.toUpperCase(),
    limit: Number(opts.limit ?? 25),
  });

  const columns: Array<Column<Instrument>> = [
    {
      header: 'Instrument',
      value: (i, io) => io.bold(formatInstrumentKey(i.exchange, i.tradingsymbol)),
    },
    { header: 'Name', value: (i) => i.name ?? '—' },
    { header: 'Type', value: (i) => i.instrument_type ?? '—' },
    { header: 'Expiry', value: (i) => i.expiry || '—' },
    {
      header: 'Strike',
      value: (i) => (i.strike ? money(i.strike) : '—'),
      align: 'right',
    },
    { header: 'Lot', value: (i) => quantity(i.lot_size), align: 'right' },
    {
      header: 'Token',
      value: (i, io) => io.dim(String(i.instrument_token)),
      align: 'right',
    },
  ];

  printTable(ctx.io, results, columns, results, {
    compact: ctx.config.output.compact,
    empty: `No instruments matched "${query}".`,
  });
}

async function refreshCommand(ctx: Context): Promise<void> {
  ctx.requireSession();
  ctx.io.info('Downloading the instrument master (this is a few MB)…');
  await ctx.instruments.load({ force: true, signal: ctx.signal });

  if (ctx.io.json) {
    ctx.io.writeJson({ refreshed: true, count: ctx.instruments.size });
    return;
  }
  ctx.io.success(`Cached ${ctx.instruments.size.toLocaleString('en-IN')} instruments.`);
  ctx.io.info('Kite regenerates this list once a day, around 08:30 IST.');
}

// ---------------------------------------------------------------------------

function normaliseKeys(args: string[]): string[] {
  if (args.length === 0) {
    throw new UsageError('At least one instrument is required, e.g. `kite quote NSE:INFY`.');
  }
  return args.map((arg) => {
    const parsed = parseInstrumentKey(arg);
    return formatInstrumentKey(parsed.exchange, parsed.tradingsymbol);
  });
}

/**
 * Kite omits instruments it has no data for rather than returning nulls, so a
 * silent gap is the normal failure mode for a typo or an expired contract.
 * Surfacing it explicitly saves a lot of confusion.
 */
function warnAboutMissing(ctx: Context, keys: string[], quotes: Record<string, unknown>): void {
  const missing = keys.filter((key) => quotes[key] === undefined);
  if (missing.length > 0) {
    ctx.io.warn(`No data for: ${missing.join(', ')}`);
    ctx.io.info('The symbol may be wrong or the contract expired. Try `kite instruments search`.');
  }
}

/**
 * Percentage change against the previous close.
 *
 * Kite sends `net_change` on quotes but it is frequently 0, so the percentage
 * is derived from OHLC instead.
 */
function changePercent(quote: Quote): number | undefined {
  const close = quote.ohlc?.close;
  if (close === undefined || close === 0) return undefined;
  return ((quote.last_price - close) / close) * 100;
}

function renderTableOrEmpty<T>(ctx: Context, rows: readonly T[], columns: Array<Column<T>>): string {
  return renderTable(ctx.io, rows, columns, {
    compact: ctx.config.output.compact,
  });
}
