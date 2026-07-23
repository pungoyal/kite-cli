import type { Context } from '../context.js';
import { type GttParams, PRODUCTS, type Product, type TransactionType } from '../core/api.js';
import { ExitCode, KiteCliError, UsageError } from '../core/errors.js';
import { formatInstrumentKey, parseInstrumentKey } from '../core/instruments.js';
import type { Gtt } from '../core/schemas.js';
import { dateOnly, money, quantity, rupees } from '../output/format.js';
import { type Column, heading, printTable, renderKeyValue, renderTable } from '../output/table.js';
import { assertTradingEnabled, confirmAction } from '../safety.js';
import type { CommandFactory } from './types.js';

/**
 * Good Till Triggered orders.
 *
 * Two shapes:
 *   single  — one trigger price, one order
 *   two-leg — OCO: two trigger prices (stop-loss and target), index-matched to
 *             two orders; whichever fires first cancels the other
 *
 * GTT orders are always LIMIT — the API rejects anything else.
 */
export const gttCommands: CommandFactory = (program, run) => {
  const gtt = program.command('gtt').description('Manage Good Till Triggered orders');

  gtt
    .command('list', { isDefault: true })
    .description('Show your GTT triggers')
    .option('--active', 'Show only active triggers')
    .action(run(listGtt));

  gtt.command('get').description('Show one GTT trigger in detail').argument('<id>').action(run(getGtt));

  gtt
    .command('place')
    .description('Create a GTT trigger')
    .argument('<instrument>', 'Instrument as EXCHANGE:SYMBOL')
    .requiredOption('-s, --side <side>', 'BUY or SELL')
    .requiredOption('-q, --quantity <n>', 'Quantity')
    .requiredOption('--trigger <price>', 'Trigger price (repeat for a two-leg OCO)', collect, [])
    .requiredOption('--price <price>', 'Limit price for the resulting order (repeat for two-leg)', collect, [])
    .option('--product <product>', `Product (${PRODUCTS.join(', ')})`, 'CNC')
    .action(run(placeGtt));

  gtt.command('delete').description('Delete a GTT trigger').argument('<id>').action(run(deleteGtt));
};

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function listGtt(ctx: Context, opts: { active?: boolean }): Promise<void> {
  ctx.requireSession();
  const all = await ctx.api.getGtts(ctx.signal);
  const rows = opts.active ? all.filter((trigger) => trigger.status === 'active') : all;

  const columns: Array<Column<Gtt>> = [
    { header: 'ID', value: (g, io) => io.dim(String(g.id)) },
    {
      header: 'Symbol',
      value: (g, io) => io.bold(`${g.condition.exchange}:${g.condition.tradingsymbol}`),
    },
    { header: 'Type', value: (g) => (g.type === 'two-leg' ? 'OCO' : 'single') },
    {
      header: 'Side',
      value: (g, io) => {
        const side = g.orders[0]?.transaction_type;
        return side === 'BUY' ? io.green('BUY') : side === 'SELL' ? io.red('SELL') : '—';
      },
    },
    {
      header: 'Qty',
      value: (g) => quantity(g.orders[0]?.quantity),
      align: 'right',
    },
    {
      header: 'Trigger',
      value: (g) => g.condition.trigger_values.map((v) => money(v)).join(' / '),
      align: 'right',
    },
    {
      header: 'LTP',
      value: (g) => money(g.condition.last_price),
      align: 'right',
    },
    { header: 'Status', value: (g, io) => colourGttStatus(io, g.status) },
    { header: 'Expires', value: (g) => dateOnly(g.expires_at) },
  ];

  printTable(ctx.io, rows, columns, rows, {
    compact: ctx.config.output.compact,
    empty: opts.active ? 'No active GTT triggers.' : 'No GTT triggers.',
  });
}

function colourGttStatus(io: Context['io'], status: string): string {
  switch (status) {
    case 'active':
      return io.green(status);
    case 'triggered':
      return io.yellow(status);
    case 'cancelled':
    case 'deleted':
    case 'expired':
      return io.dim(status);
    case 'rejected':
      return io.red(status);
    default:
      return status;
  }
}

async function getGtt(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const id = requireId(command.args[0]);
  const trigger = await ctx.api.getGtt(id, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(trigger);
    return;
  }

  const { io } = ctx;
  io.line(heading(io, `GTT ${trigger.id}`));
  io.line(
    renderKeyValue(io, [
      ['Instrument', `${trigger.condition.exchange}:${trigger.condition.tradingsymbol}`],
      ['Type', trigger.type === 'two-leg' ? 'two-leg (OCO)' : 'single'],
      ['Status', colourGttStatus(io, trigger.status)],
      ['Trigger prices', trigger.condition.trigger_values.map((v) => money(v)).join(' / ')],
      ['Last price', money(trigger.condition.last_price)],
      ['Created', dateOnly(trigger.created_at)],
      ['Expires', dateOnly(trigger.expires_at)],
    ]),
  );

  io.line(heading(io, 'Orders'));
  io.line(
    renderTableFor(ctx, trigger.orders, [
      {
        header: 'Side',
        value: (o, io) => (o.transaction_type === 'BUY' ? io.green('BUY') : io.red('SELL')),
      },
      { header: 'Qty', value: (o) => quantity(o.quantity), align: 'right' },
      { header: 'Price', value: (o) => money(o.price), align: 'right' },
      { header: 'Product', value: (o) => o.product ?? '—' },
      { header: 'Type', value: (o) => o.order_type ?? '—' },
    ]),
  );
}

async function placeGtt(
  ctx: Context,
  opts: {
    side: string;
    quantity: string;
    trigger: string[];
    price: string[];
    product?: string;
  },
  command: { args: string[] },
): Promise<void> {
  ctx.requireSession();
  assertTradingEnabled(ctx);

  const instrumentArg = command.args[0];
  if (!instrumentArg) throw new UsageError('An instrument is required.');
  const instrument = parseInstrumentKey(instrumentArg);
  const instrumentKey = formatInstrumentKey(instrument.exchange, instrument.tradingsymbol);

  const side = opts.side.toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new UsageError('--side must be BUY or SELL.');

  const qty = Number(opts.quantity);
  if (!Number.isInteger(qty) || qty <= 0) throw new UsageError('--quantity must be a positive whole number.');

  const triggers = opts.trigger.map((value) => requirePrice(value, '--trigger'));
  const prices = opts.price.map((value) => requirePrice(value, '--price'));

  if (triggers.length !== prices.length) {
    throw new UsageError(
      `Got ${triggers.length} trigger price(s) and ${prices.length} limit price(s).`,
      'Each --trigger needs a matching --price, in the same order.',
    );
  }
  if (triggers.length !== 1 && triggers.length !== 2) {
    throw new UsageError('A GTT takes either 1 trigger (single) or 2 triggers (two-leg OCO).');
  }

  const product = normaliseProduct(opts.product ?? 'CNC');
  const type = triggers.length === 2 ? 'two-leg' : 'single';

  // The trigger condition needs a current last_price, and Kite validates it.
  const ltpMap = await ctx.api.getLtp([instrumentKey], ctx.signal);
  const lastPrice = ltpMap[instrumentKey]?.last_price;
  if (lastPrice === undefined) {
    throw new KiteCliError(
      `Could not fetch a last price for ${instrumentKey}, which a GTT requires.`,
      ExitCode.Input,
      'Check the symbol with `kite instruments search`.',
    );
  }

  const params: GttParams = {
    type,
    condition: {
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      trigger_values: triggers,
      last_price: lastPrice,
    },
    orders: triggers.map((_, index) => ({
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      transaction_type: side as TransactionType,
      quantity: qty,
      // GTT only supports LIMIT orders.
      order_type: 'LIMIT' as const,
      product,
      price: prices[index]!,
    })),
  };

  const notionalValue = Math.max(...prices) * qty;

  await confirmAction(ctx, {
    action: `Create ${type} GTT for ${qty} ${instrument.tradingsymbol}`,
    mutatesOrders: true,
    // A GTT places a real order when it triggers.
    increasesExposure: true,
    notionalValue,
    challengeToken: instrument.tradingsymbol,
    details: [
      { label: 'Instrument', value: instrumentKey },
      { label: 'Type', value: type === 'two-leg' ? 'two-leg (OCO)' : 'single' },
      {
        label: 'Side',
        value: side === 'BUY' ? ctx.io.green(side) : ctx.io.red(side),
      },
      { label: 'Quantity', value: quantity(qty) },
      { label: 'Last price', value: rupees(lastPrice) },
      ...triggers.map((trigger, index) => ({
        label: type === 'two-leg' ? (index === 0 ? 'Leg 1' : 'Leg 2') : 'Trigger',
        value: `trigger at ${rupees(trigger)} → LIMIT ${rupees(prices[index]!)}`,
      })),
      { label: 'Product', value: product },
      { label: 'Max value', value: rupees(notionalValue) },
    ],
  });

  if (ctx.options.dryRun) return;

  const result = await ctx.api.placeGtt(params, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(result);
    return;
  }
  ctx.io.success(`GTT created: ${ctx.io.bold(String(result.trigger_id))}`);
  ctx.io.info('GTT triggers expire after one year, or when Kite invalidates them.');
}

async function deleteGtt(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  assertTradingEnabled(ctx);
  const id = requireId(command.args[0]);

  // Enrichment for the preview. Deleting a GTT only removes a pending trigger,
  // so a failed lookup does not need to block — but the user must be told the
  // preview below is unverified rather than silently shown "unknown".
  let existing: Gtt | undefined;
  try {
    existing = await ctx.api.getGtt(id, ctx.signal);
  } catch {
    ctx.io.warn(`Could not read GTT ${id} from Kite; the details below are unverified.`);
  }

  await confirmAction(ctx, {
    action: `Delete GTT ${id}`,
    mutatesOrders: true,
    details: [
      { label: 'GTT ID', value: String(id) },
      {
        label: 'Instrument',
        value: existing ? `${existing.condition.exchange}:${existing.condition.tradingsymbol}` : 'unknown',
      },
      { label: 'Status', value: existing?.status ?? 'unknown' },
      {
        label: 'Triggers',
        value: existing ? existing.condition.trigger_values.map((v) => money(v)).join(' / ') : 'unknown',
      },
    ],
  });

  if (ctx.options.dryRun) return;

  const result = await ctx.api.deleteGtt(id, ctx.signal);
  if (ctx.io.json) {
    ctx.io.writeJson(result);
    return;
  }
  ctx.io.success(`GTT ${result.trigger_id} deleted.`);
}

function requireId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new UsageError('A numeric GTT ID is required.');
  return id;
}

function requirePrice(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number.`);
  return n;
}

function normaliseProduct(value: string): Product {
  const upper = value.toUpperCase();
  if ((PRODUCTS as string[]).includes(upper)) return upper as Product;
  throw new UsageError(`Unknown product "${value}".`, `Valid products: ${PRODUCTS.join(', ')}.`);
}

function renderTableFor<T>(ctx: Context, rows: readonly T[], columns: Array<Column<T>>): string {
  return renderTable(ctx.io, rows, columns, {
    compact: ctx.config.output.compact,
  });
}
