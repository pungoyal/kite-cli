import type { Context } from '../context.js';
import { UsageError } from '../core/errors.js';
import type { MfHolding, MfInstrument, MfOrder, MfSip } from '../core/schemas.js';
import { dateTime, money, quantity, rupees, signedRupees } from '../output/format.js';
import { type Column, heading, printTable, renderKeyValue } from '../output/table.js';
import { examples } from './examples.js';
import type { CommandFactory } from './types.js';

/**
 * Mutual funds — read only.
 *
 * Kite Connect does not offer MF order placement or SIP management over the
 * API (an MF purchase needs a bank debit the API can't authorise), so this is
 * holdings, recent orders, and SIPs — the three read endpoints — and nothing
 * that moves money. No kill switch, value cap, or confirmation applies.
 */
export const mfCommands: CommandFactory = (program, run) => {
  const mf = program
    .command('mf')
    .description('View mutual fund holdings, orders and SIPs')
    .addHelpText(
      'after',
      examples([
        ['kite mf', 'Your fund holdings (holdings is the default)'],
        ['kite mf orders', 'Purchases and redemptions from the last 7 days'],
        ['kite mf sips', 'Standing instructions and their next instalment'],
      ]),
    );

  mf.command('holdings', { isDefault: true })
    .description('Show your mutual fund holdings')
    .addHelpText(
      'after',
      examples([
        ['kite mf holdings', 'Units, average cost and current value per fund'],
        [`kite mf holdings --json | jq '[.[].pnl] | add'`, 'Total unrealised P&L across funds'],
      ]),
    )
    .action(run(mfHoldings));

  const orders = mf
    .command('orders')
    .description('View mutual fund orders')
    .addHelpText(
      'after',
      examples([
        ['kite mf orders', 'Recent purchases and redemptions (list is the default)'],
        ['kite mf orders get 1234567890123456', 'One order, regardless of age'],
      ]),
    );

  orders
    .command('list', { isDefault: true })
    .description('Show mutual fund orders from the last 7 days')
    .addHelpText('after', examples([['kite mf orders', 'Recent purchases and redemptions']]))
    .action(run(mfOrders));

  orders
    .command('get')
    .description('Show a single mutual fund order, regardless of age')
    .argument('<order-id>')
    .addHelpText(
      'after',
      examples([['kite mf orders get 1234567890123456', 'Unlike the list, this reaches back further than 7 days']]),
    )
    .action(run(mfOrderGet));

  mf.command('sips')
    .description('Show your mutual fund SIPs')
    .addHelpText('after', examples([['kite mf sips', 'Every SIP, its instalment and next due date']]))
    .action(run(mfSips));

  const instruments = mf
    .command('instruments')
    .description('Browse the mutual fund instrument master (Coin-supported funds)')
    .addHelpText(
      'after',
      examples([
        ['kite mf instruments search "parag parikh"', 'Find a fund to use elsewhere'],
        ['kite mf instruments refresh', 'Re-download after new listings'],
      ]),
    );

  instruments
    .command('search')
    .description('Search mutual fund schemes by name')
    .argument('<query>', 'Search text, e.g. "parag parikh flexi cap"')
    .option('--amc <amc>', 'Filter by AMC, e.g. ParagParikhMutualFund_MF')
    .option('--plan <plan>', 'Filter by plan, e.g. direct, regular')
    .option('-n, --limit <n>', 'Maximum results', '25')
    .addHelpText(
      'after',
      examples([
        ['kite mf instruments search "nifty 50 index"', 'Every index fund matching that name'],
        ['kite mf instruments search "small cap" --plan direct', 'Direct plans only'],
        ['kite mf instruments search axis --amc AxisMutualFund_MF', 'One AMC only'],
      ]),
    )
    .action(run(mfInstrumentSearch));

  instruments
    .command('refresh')
    .description('Re-download the mutual fund instrument master')
    .addHelpText('after', examples([['kite mf instruments refresh', 'Refresh the cached fund list']]))
    .action(run(mfInstrumentRefresh));
};

async function mfHoldings(ctx: Context): Promise<void> {
  ctx.requireSession();
  const rows = await ctx.api.getMfHoldings(ctx.signal);

  const columns: Array<Column<MfHolding>> = [
    { header: 'Fund', value: (h, io) => io.bold(h.fund ?? h.tradingsymbol) },
    { header: 'Folio', value: (h) => h.folio ?? '—' },
    { header: 'Units', value: (h) => quantity(h.quantity), align: 'right' },
    { header: 'Avg', value: (h) => money(h.average_price), align: 'right' },
    { header: 'NAV', value: (h) => money(h.last_price), align: 'right' },
    { header: 'Value', value: (h) => money(h.last_price * h.quantity), align: 'right' },
    { header: 'P&L', value: (h, io) => io.signed(h.pnl, signedRupees(h.pnl)), align: 'right' },
  ];

  printTable(ctx.io, rows, columns, rows, {
    compact: ctx.config.output.compact,
    empty: 'No mutual fund holdings.',
  });

  if (ctx.io.json) return;

  const totalValue = rows.reduce((sum, h) => sum + h.last_price * h.quantity, 0);
  const totalPnl = rows.reduce((sum, h) => sum + h.pnl, 0);
  if (rows.length > 0) {
    const { io } = ctx;
    io.line('');
    io.line(`  Current value ${rupees(totalValue)}   P&L ${io.signed(totalPnl, signedRupees(totalPnl))}`);
  }
}

async function mfOrders(ctx: Context): Promise<void> {
  ctx.requireSession();
  const rows = await ctx.api.getMfOrders(ctx.signal);

  const columns: Array<Column<MfOrder>> = [
    { header: 'Order ID', value: (o, io) => io.dim(o.order_id) },
    { header: 'Fund', value: (o, io) => io.bold(o.fund ?? o.tradingsymbol ?? '—') },
    {
      header: 'Side',
      value: (o, io) =>
        o.transaction_type === 'BUY'
          ? io.green('BUY')
          : o.transaction_type === 'SELL'
            ? io.red('SELL')
            : (o.transaction_type ?? '—'),
    },
    { header: 'Status', value: (o) => o.status ?? '—' },
    { header: 'Units', value: (o) => quantity(o.quantity ?? undefined), align: 'right' },
    { header: 'Amount', value: (o) => money(o.amount ?? undefined), align: 'right' },
    { header: 'When', value: (o) => dateTime(o.order_timestamp ?? undefined) },
  ];

  printTable(ctx.io, rows, columns, rows, {
    compact: ctx.config.output.compact,
    // An empty list can just mean nothing was placed recently, not that you have
    // no MF history — the endpoint only reaches back 7 days.
    empty: 'No mutual fund orders in the last 7 days.',
  });
}

/**
 * `mf orders` (the list) only reaches back 7 days; this is the single-order
 * endpoint that returns a fund order irrespective of its age.
 */
async function mfOrderGet(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const orderId = command.args[0];
  if (!orderId) throw new UsageError('An order ID is required.');

  const order = await ctx.api.getMfOrder(orderId, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(order);
    return;
  }

  const { io } = ctx;
  io.line(heading(io, `MF order ${orderId}`));
  io.line(
    renderKeyValue(io, [
      ['Fund', order.fund ?? order.tradingsymbol ?? '—'],
      [
        'Side',
        order.transaction_type === 'BUY'
          ? io.green('BUY')
          : order.transaction_type === 'SELL'
            ? io.red('SELL')
            : (order.transaction_type ?? '—'),
      ],
      ['Status', order.status ?? '—'],
      ['Message', order.status_message ?? '—'],
      ['Folio', order.folio ?? '—'],
      ['Units', quantity(order.quantity ?? undefined)],
      ['Amount', money(order.amount ?? undefined)],
      ['Average price', money(order.average_price ?? undefined)],
      ['Placed', dateTime(order.order_timestamp ?? undefined)],
    ]),
  );
}

async function mfSips(ctx: Context): Promise<void> {
  ctx.requireSession();
  const rows = await ctx.api.getMfSips(ctx.signal);

  const columns: Array<Column<MfSip>> = [
    { header: 'SIP ID', value: (s, io) => io.dim(s.sip_id) },
    { header: 'Fund', value: (s, io) => io.bold(s.fund ?? s.tradingsymbol ?? '—') },
    { header: 'Status', value: (s) => s.status ?? '—' },
    { header: 'Instalment', value: (s) => money(s.instalment_amount), align: 'right' },
    { header: 'Done', value: (s) => quantity(s.instalments), align: 'right' },
    { header: 'Frequency', value: (s) => s.frequency ?? '—' },
    { header: 'Next', value: (s) => dateTime(s.next_instalment ?? undefined) },
  ];

  printTable(ctx.io, rows, columns, rows, {
    compact: ctx.config.output.compact,
    empty: 'No mutual fund SIPs.',
  });
}

async function mfInstrumentSearch(
  ctx: Context,
  opts: { amc?: string; plan?: string; limit?: string },
  command: { args: string[] },
): Promise<void> {
  ctx.requireSession();
  const query = command.args.join(' ');

  await ctx.mfInstruments.load({ signal: ctx.signal });
  const results = ctx.mfInstruments.search(query, {
    amc: opts.amc,
    plan: opts.plan,
    limit: Number(opts.limit ?? 25),
  });

  const columns: Array<Column<MfInstrument>> = [
    { header: 'Fund', value: (i, io) => io.bold(i.name ?? i.tradingsymbol) },
    { header: 'AMC', value: (i) => i.amc ?? '—' },
    { header: 'Plan', value: (i) => i.plan ?? '—' },
    { header: 'Dividend', value: (i) => i.dividend_type ?? '—' },
    { header: 'Type', value: (i) => i.scheme_type ?? '—' },
    { header: 'NAV', value: (i) => (i.last_price !== undefined ? money(i.last_price) : '—'), align: 'right' },
    {
      header: 'Min purchase',
      value: (i) => (i.minimum_purchase_amount !== undefined ? money(i.minimum_purchase_amount) : '—'),
      align: 'right',
    },
    { header: 'ISIN', value: (i, io) => io.dim(i.tradingsymbol) },
  ];

  printTable(ctx.io, results, columns, results, {
    compact: ctx.config.output.compact,
    empty: `No mutual funds matched "${query}".`,
  });
}

async function mfInstrumentRefresh(ctx: Context): Promise<void> {
  ctx.requireSession();
  ctx.io.info('Downloading the mutual fund instrument master…');
  await ctx.mfInstruments.load({ force: true, signal: ctx.signal });

  if (ctx.io.json) {
    ctx.io.writeJson({ refreshed: true, count: ctx.mfInstruments.size });
    return;
  }
  ctx.io.success(`Cached ${ctx.mfInstruments.size.toLocaleString('en-IN')} mutual fund instruments.`);
}
