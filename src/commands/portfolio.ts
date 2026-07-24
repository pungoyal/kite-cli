import type { Command } from 'commander';
import type { Context } from '../context.js';
import { PRODUCTS, type Product, type TransactionType } from '../core/api.js';
import { UsageError } from '../core/errors.js';
import type { Holding, Position, SegmentMargin } from '../core/schemas.js';
import { money, percent, quantity, rupees, signedRupees } from '../output/format.js';
import { type Column, heading, printTable, renderKeyValue } from '../output/table.js';
import { confirmAction } from '../safety.js';
import { examples } from './examples.js';
import type { CommandFactory } from './types.js';

export const portfolioCommands: CommandFactory = (program, run) => {
  program
    .command('holdings')
    .description('Show your long-term holdings')
    .option('--sort <field>', 'Sort by: symbol, value, pnl, day', 'value')
    .addHelpText(
      'after',
      examples([
        ['kite holdings', 'Everything you hold, largest position first'],
        ['kite holdings --sort pnl', 'Best to worst performer'],
        ['kite holdings --sort day', "Sort by today's move"],
        ["kite holdings --json | jq -r '.[].tradingsymbol'", 'Just the symbols, for scripting'],
      ]),
    )
    .action(run(holdings));

  program
    .command('positions')
    .description('Show your open positions')
    .option('--day', 'Show intraday positions instead of net')
    .addHelpText(
      'after',
      examples([
        ['kite positions', 'Net positions carried plus today'],
        ['kite positions --day', "Only today's intraday positions"],
        ["kite positions --json | jq '.[].pnl'", 'JSON is the array being shown, not {net, day}'],
      ]),
    )
    .action(run(positions));

  program
    .command('funds')
    .description('Show available margin and funds')
    .option('--segment <segment>', 'equity or commodity')
    .addHelpText(
      'after',
      examples([
        ['kite funds', 'Equity and commodity margins'],
        ['kite funds --segment equity', 'Equity only'],
        ['kite funds --json | jq .equity.net', 'Cash available to trade'],
      ]),
    )
    .action(run(funds));

  program
    .command('authorise')
    .alias('authorize')
    .description('Authorise holdings at the depository so they can be sold (recovers from HTTP 428)')
    .argument('[isins...]', 'Specific ISINs to authorise. Omit to authorise the whole demat account.')
    .addHelpText(
      'after',
      examples([
        ['kite authorise', 'Authorise the whole demat account'],
        ['kite authorise INE009A01021', 'Authorise one holding by ISIN'],
        ['kite authorise INE009A01021 INE467B01029', 'Authorise several at once'],
      ]),
    )
    .action(run(authoriseHoldings));

  const convert = program
    .command('convert')
    .description('Convert a position between products (e.g. MIS to CNC)')
    .argument('<instrument>', 'Instrument as EXCHANGE:SYMBOL, e.g. NSE:INFY')
    .requiredOption('--quantity <n>', 'Quantity to convert')
    .requiredOption('--from <product>', `Current product (${PRODUCTS.join(', ')})`)
    .requiredOption('--to <product>', `Target product (${PRODUCTS.join(', ')})`)
    .option('--transaction-type <type>', 'BUY or SELL', 'BUY')
    .option('--position-type <type>', 'overnight or day', 'day')
    .addHelpText(
      'after',
      examples([
        ['kite convert NSE:INFY --quantity 10 --from MIS --to CNC', 'Carry an intraday buy forward as delivery'],
        ['kite convert NSE:INFY --quantity 10 --from MIS --to CNC --dry-run', 'Preview it first'],
        [
          'kite convert NFO:NIFTY25AUGFUT --quantity 75 --from NRML --to MIS --transaction-type SELL',
          'Convert a short futures position to intraday margin',
        ],
      ]),
    )
    .action(run(convertPosition));
  void convert;
};

async function holdings(ctx: Context, opts: { sort?: string }): Promise<void> {
  ctx.requireSession();
  const rows = await ctx.api.getHoldings(ctx.signal);

  const sorted = [...rows].sort(sorter(opts.sort ?? 'value'));

  const totalInvested = sorted.reduce((sum, h) => sum + h.average_price * h.quantity, 0);
  const totalCurrent = sorted.reduce((sum, h) => sum + h.last_price * h.quantity, 0);
  const totalPnl = totalCurrent - totalInvested;
  const totalDayChange = sorted.reduce((sum, h) => sum + h.day_change * h.quantity, 0);

  const columns: Array<Column<Holding>> = [
    { header: 'Symbol', value: (h, io) => io.bold(h.tradingsymbol) },
    { header: 'Exch', value: (h) => h.exchange },
    {
      header: 'Qty',
      value: (h) => quantity(h.quantity + h.t1_quantity),
      align: 'right',
    },
    { header: 'Avg', value: (h) => money(h.average_price), align: 'right' },
    { header: 'LTP', value: (h) => money(h.last_price), align: 'right' },
    {
      header: 'Value',
      value: (h) => money(h.last_price * h.quantity),
      align: 'right',
    },
    {
      header: 'P&L',
      value: (h, io) => io.signed(h.pnl, signedRupees(h.pnl)),
      align: 'right',
    },
    {
      header: 'P&L %',
      value: (h, io) => {
        const invested = h.average_price * h.quantity;
        const pct = invested === 0 ? 0 : (h.pnl / invested) * 100;
        return io.signed(pct, percent(pct));
      },
      align: 'right',
    },
    {
      header: 'Day',
      value: (h, io) => io.signed(h.day_change_percentage, percent(h.day_change_percentage)),
      align: 'right',
    },
  ];

  printTable(ctx.io, sorted, columns, rows, {
    compact: ctx.config.output.compact,
    empty: 'No holdings.',
  });

  if (ctx.io.json) return;

  const { io } = ctx;
  io.line(
    renderKeyValue(io, [
      ['Invested', rupees(totalInvested)],
      ['Current', rupees(totalCurrent)],
      [
        'P&L',
        io.signed(
          totalPnl,
          `${signedRupees(totalPnl)}  ${percent(totalInvested === 0 ? 0 : (totalPnl / totalInvested) * 100)}`,
        ),
      ],
      ["Day's change", io.signed(totalDayChange, signedRupees(totalDayChange))],
    ]),
  );
}

function sorter(field: string): (a: Holding, b: Holding) => number {
  switch (field) {
    case 'symbol':
      return (a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol);
    case 'pnl':
      return (a, b) => b.pnl - a.pnl;
    case 'day':
      return (a, b) => b.day_change_percentage - a.day_change_percentage;
    case 'value':
      return (a, b) => b.last_price * b.quantity - a.last_price * a.quantity;
    default:
      throw new UsageError(`Unknown sort field "${field}".`, 'Valid fields: symbol, value, pnl, day.');
  }
}

async function positions(ctx: Context, opts: { day?: boolean }): Promise<void> {
  ctx.requireSession();
  const result = await ctx.api.getPositions(ctx.signal);
  const rows = opts.day ? result.day : result.net;

  const columns: Array<Column<Position>> = [
    { header: 'Symbol', value: (p, io) => io.bold(p.tradingsymbol) },
    { header: 'Exch', value: (p) => p.exchange },
    { header: 'Product', value: (p) => p.product ?? '—' },
    {
      header: 'Qty',
      value: (p, io) => io.signed(p.quantity, quantity(p.quantity)),
      align: 'right',
    },
    { header: 'Avg', value: (p) => money(p.average_price), align: 'right' },
    { header: 'LTP', value: (p) => money(p.last_price), align: 'right' },
    {
      header: 'P&L',
      value: (p, io) => io.signed(p.pnl, signedRupees(p.pnl)),
      align: 'right',
    },
    {
      header: 'M2M',
      value: (p, io) => io.signed(p.m2m, signedRupees(p.m2m)),
      align: 'right',
    },
  ];

  // The JSON payload is always the array of positions being displayed. Emitting
  // the whole {net, day} envelope for one flag and a bare array for the other
  // would force every consumer to branch on the flag they passed.
  printTable(ctx.io, rows, columns, rows, {
    compact: ctx.config.output.compact,
    empty: opts.day ? 'No intraday positions.' : 'No open positions.',
  });

  if (ctx.io.json) return;

  const totalPnl = rows.reduce((sum, p) => sum + p.pnl, 0);
  const { io } = ctx;
  io.line(renderKeyValue(io, [['Total P&L', io.signed(totalPnl, signedRupees(totalPnl))]]));

  const open = rows.filter((p) => p.quantity !== 0);
  if (open.length > 0 && !opts.day) {
    io.note('');
    io.info('To exit a position, place an opposite order with the SAME product — otherwise it opens a new position.');
  }
}

async function funds(ctx: Context, opts: { segment?: string }): Promise<void> {
  ctx.requireSession();
  const margins = await ctx.api.getMargins(ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(margins);
    return;
  }

  const { io } = ctx;
  const segments: Array<[string, SegmentMargin | undefined]> = [
    ['Equity', margins.equity],
    ['Commodity', margins.commodity],
  ];

  for (const [name, segment] of segments) {
    if (!segment) continue;
    if (opts.segment && opts.segment.toLowerCase() !== name.toLowerCase()) continue;

    io.line(heading(io, name));
    io.line(
      renderKeyValue(io, [
        ['Available', rupees(segment.net)],
        ['Cash', rupees(segment.available?.cash)],
        ['Opening balance', rupees(segment.available?.opening_balance)],
        ['Collateral', rupees(segment.available?.collateral)],
        ['Used', rupees(segment.utilised?.debits)],
        ['SPAN', rupees(segment.utilised?.span)],
        ['Exposure', rupees(segment.utilised?.exposure)],
        ['Option premium', rupees(segment.utilised?.option_premium)],
        ['Realised P&L', io.signed(segment.utilised?.m2m_realised ?? 0, signedRupees(segment.utilised?.m2m_realised))],
        [
          'Unrealised P&L',
          io.signed(segment.utilised?.m2m_unrealised ?? 0, signedRupees(segment.utilised?.m2m_unrealised)),
        ],
      ]),
    );
  }
}

/**
 * Recover from HTTP 428 — "N quantity needs authorisation at depository".
 *
 * Selling shares held in demat requires a CDSL authorisation the user must
 * complete in a browser. We request an id, then hand them the URL. The
 * authorisation is valid until 5:30 PM the same day.
 */
async function authoriseHoldings(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const isins = command.args.map((isin) => isin.trim().toUpperCase()).filter(Boolean);

  const result = await ctx.api.authoriseHoldings(isins, ctx.signal);
  const url = ctx.api.authorisationUrl(result.request_id);

  if (ctx.io.json) {
    ctx.io.writeJson({ request_id: result.request_id, url, isins });
    return;
  }

  const { io } = ctx;
  io.note('');
  io.info(
    isins.length > 0
      ? `Authorising ${isins.length} instrument(s): ${isins.join(', ')}`
      : 'Authorising your entire demat account.',
  );
  io.note('');
  io.note(`  ${io.bold(url)}`);
  io.note('');
  io.info('Open that URL to complete the authorisation with CDSL.');
  io.info('It stays valid until 5:30 PM IST today.');

  const { openBrowser } = await import('../core/auth.js');
  if (await openBrowser(url)) {
    io.success('Opened your browser.');
  }
}

async function convertPosition(
  ctx: Context,
  opts: {
    quantity: string;
    from: string;
    to: string;
    transactionType?: string;
    positionType?: string;
  },
  command: Command,
): Promise<void> {
  ctx.requireSession();
  const instrument = command.args[0] ?? '';
  const { parseInstrumentKey } = await import('../core/instruments.js');
  const parsed = parseInstrumentKey(instrument);

  const qty = Number(opts.quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new UsageError('--quantity must be a positive whole number.');
  }

  const from = normaliseProduct(opts.from);
  const to = normaliseProduct(opts.to);
  if (from === to) {
    throw new UsageError('--from and --to are the same product; nothing to convert.');
  }

  const transactionType = (opts.transactionType ?? 'BUY').toUpperCase() as TransactionType;
  if (transactionType !== 'BUY' && transactionType !== 'SELL') {
    throw new UsageError('--transaction-type must be BUY or SELL.');
  }

  const positionType = (opts.positionType ?? 'day').toLowerCase();
  if (positionType !== 'day' && positionType !== 'overnight') {
    throw new UsageError('--position-type must be day or overnight.');
  }

  await confirmAction(ctx, {
    action: `Convert ${qty} ${parsed.tradingsymbol} from ${from} to ${to}`,
    mutatesOrders: true,
    details: [
      ['Instrument', `${parsed.exchange}:${parsed.tradingsymbol}`],
      ['Quantity', quantity(qty)],
      ['From product', from],
      ['To product', to],
      ['Transaction', transactionType],
      ['Position type', positionType],
    ].map(([label, value]) => ({ label: label!, value: value! })),
  });

  if (ctx.options.dryRun) return;

  await ctx.api.convertPosition(
    {
      tradingsymbol: parsed.tradingsymbol,
      exchange: parsed.exchange,
      transaction_type: transactionType,
      position_type: positionType as 'day' | 'overnight',
      quantity: qty,
      old_product: from,
      new_product: to,
    },
    ctx.signal,
  );

  if (ctx.io.json) {
    ctx.io.writeJson({
      converted: true,
      tradingsymbol: parsed.tradingsymbol,
      from,
      to,
      quantity: qty,
    });
    return;
  }
  ctx.io.success(`Converted ${qty} ${parsed.tradingsymbol} from ${from} to ${to}.`);
}

function normaliseProduct(value: string): Product {
  const upper = value.toUpperCase();
  if ((PRODUCTS as string[]).includes(upper)) return upper as Product;
  throw new UsageError(`Unknown product "${value}".`, `Valid products: ${PRODUCTS.join(', ')}.`);
}
