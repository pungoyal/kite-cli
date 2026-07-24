import type { Context } from '../context.js';
import {
  GTT_ORDER_TYPES,
  type GttOrderType,
  type GttParams,
  PRODUCTS,
  type Product,
  type TransactionType,
} from '../core/api.js';
import { UsageError } from '../core/errors.js';
import { formatInstrumentKey, parseInstrumentKey } from '../core/instruments.js';
import type { Gtt } from '../core/schemas.js';
import { dateOnly, money, quantity, rupees } from '../output/format.js';
import { type Column, heading, printTable, renderKeyValue, renderTable } from '../output/table.js';
import { assertTradingEnabled, confirmAction } from '../safety.js';
import { examples } from './examples.js';
import type { CommandFactory } from './types.js';

/**
 * Good Till Triggered orders.
 *
 * Two shapes:
 *   single  — one trigger price, one order
 *   two-leg — OCO: a stoploss and a target, whichever fires first cancelling
 *             the other
 *
 * On the wire an OCO is two `trigger_values` index-matched to two orders, and
 * Kite only accepts it when one trigger sits either side of the last price —
 * anything else is "Condition already met". That geometry is exactly what
 * "stoploss" and "target" mean once you know the side, so the CLI takes the
 * legs by name and works out the array order itself, rather than making the
 * caller encode it positionally and get told off by Kite afterwards.
 *
 * A BUY OCO closes a short: stoploss above the price, target below. A SELL OCO
 * closes a long, so the two swap.
 */
export const gttCommands: CommandFactory = (program, run) => {
  const gtt = program
    .command('gtt')
    .description('Manage Good Till Triggered orders')
    .addHelpText(
      'after',
      examples([
        ['kite gtt', 'Your standing triggers'],
        ['kite gtt place NSE:INFY -s SELL -q 10 --trigger 1400 --price 1395', 'A single-leg stop, valid for a year'],
        [
          'kite gtt place NSE:INFY -s SELL -q 10 --stoploss 1400 --target 1800 -t MARKET',
          'An OCO: whichever leg fires first cancels the other',
        ],
        ['kite gtt delete 123456', 'Remove a trigger'],
      ]),
    );

  gtt
    .command('list', { isDefault: true })
    .description('Show your GTT triggers')
    .option('--active', 'Show only active triggers')
    .addHelpText(
      'after',
      examples([
        ['kite gtt', 'Every trigger, including triggered and cancelled ones'],
        ['kite gtt list --active', 'Only triggers still waiting'],
        [`kite gtt list --active --json | jq -r '.[].id'`, 'Trigger ids, for scripting'],
      ]),
    )
    .action(run(listGtt));

  gtt
    .command('get')
    .description('Show one GTT trigger in detail')
    .argument('<id>')
    .addHelpText(
      'after',
      examples([
        ['kite gtt get 123456', 'Both legs, their triggers, and the current status'],
        ['kite gtt get 123456 --json', 'The raw trigger as Kite stores it'],
      ]),
    )
    .action(run(getGtt));

  gtt
    .command('place')
    .description('Create a GTT trigger')
    .argument('<instrument>', 'Instrument as EXCHANGE:SYMBOL')
    .requiredOption('-s, --side <side>', 'BUY or SELL')
    .requiredOption('-q, --quantity <n>', 'Quantity')
    .option('--trigger <price>', 'Trigger price for a single-leg GTT', collect, [])
    .option('--price <price>', 'Limit price for a single-leg GTT')
    .option('--stoploss <price|pct%>', "An OCO's stoploss trigger, as a price or a distance from the last price")
    .option('--target <price|pct%>', "An OCO's target trigger, as a price or a distance from the last price")
    .option('--stoploss-price <price>', "Limit price for the OCO's stoploss leg")
    .option('--target-price <price>', "Limit price for the OCO's target leg")
    .option('-t, --order-type <type>', `Order type placed when a trigger fires (${GTT_ORDER_TYPES.join(', ')})`)
    .option('--product <product>', `Product (${PRODUCTS.join(', ')}); required on a derivatives exchange`)
    .option(
      '--last-price <price>',
      'Reference price for percentage triggers and the leg-direction check; never sent to Kite',
    )
    .addHelpText(
      'after',
      `
A GTT is either single-leg (--trigger, one --price) or an OCO (--stoploss and
--target, priced with --stoploss-price and --target-price). The two shapes never
mix, and for a SELL the stoploss sits below the last price while the target sits
above — pass --last-price to have that checked before anything is created.
${examples([
  [
    'kite gtt place NSE:INFY -s SELL -q 10 --trigger 1400 --price 1395',
    'Single leg: trigger at 1400, sell down to 1395',
  ],
  [
    'kite gtt place NSE:INFY -s BUY -q 10 --trigger 1800 -t MARKET',
    'Single leg at market — no limit price, so the type is explicit',
  ],
  [
    'kite gtt place NSE:INFY -s SELL -q 10 --stoploss 1400 --target 1800 -t MARKET',
    'OCO at market: stop below, target above',
  ],
  [
    'kite gtt place NSE:INFY -s SELL -q 10 --stoploss 1400 --stoploss-price 1395 --target 1800 --target-price 1795',
    'OCO with a limit price on each leg',
  ],
  [
    'kite gtt place NSE:INFY -s SELL -q 10 --stoploss 5% --target 10% --last-price 1650 -t MARKET',
    'Legs as a distance from a reference price',
  ],
  [
    'kite gtt place NFO:NIFTY25AUGFUT -s SELL -q 75 --trigger 24000 -t MARKET --product NRML',
    '--product is required on a derivatives exchange',
  ],
  ['kite gtt place NSE:INFY -s SELL -q 10 --trigger 1400 --price 1395 --dry-run', 'Preview without creating it'],
])}`,
    )
    .action(run(placeGtt));

  gtt
    .command('delete')
    .description('Delete a GTT trigger')
    .argument('<id>')
    .addHelpText(
      'after',
      examples([
        ['kite gtt delete 123456', 'Delete one trigger'],
        [`kite gtt list --active --json | jq -r '.[].id' | xargs -n1 kite gtt delete -y`, 'Clear every active trigger'],
      ]),
    )
    .action(run(deleteGtt));
};

/** Exchanges where CNC — an equity-delivery product — is not a valid choice. */
const DERIVATIVE_EXCHANGES = new Set(['NFO', 'MCX', 'BFO', 'CDS', 'BCD', 'NCO']);

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
      {
        header: 'Price',
        // A MARKET leg carries price 0; rendering that as ₹0.00 would read as a
        // real limit price of zero.
        value: (o, io) => (o.order_type === 'MARKET' ? io.dim('at market') : money(o.price)),
        align: 'right',
      },
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
    price?: string;
    stoploss?: string;
    target?: string;
    stoplossPrice?: string;
    targetPrice?: string;
    orderType?: string;
    product?: string;
    lastPrice?: string;
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

  const isOco = assertShapeIsCoherent(opts);
  const type = isOco ? 'two-leg' : 'single';
  const product = normaliseProduct(opts.product, instrument.exchange);
  const orderType = resolveOrderType(opts, isOco);

  // Optional, and never sent to Kite — see buildCondition. It is here only so a
  // percentage trigger has something to be a percentage of, and so the legs can
  // be checked against the side they are supposed to be on.
  const lastPrice = opts.lastPrice === undefined ? undefined : requirePrice(opts.lastPrice, '--last-price');

  const legs = isOco ? resolveOcoLegs(opts, side, orderType, lastPrice) : [resolveSingleLeg(opts, orderType)];

  const params: GttParams = {
    type,
    condition: {
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      // Kite orders the array itself only in the sense that it index-matches it
      // to `orders`; the two must ascend together, which sortForWire does.
      trigger_values: legs.map((leg) => leg.trigger),
      // `last_price` is deliberately absent. It is documented as a parameter but
      // is not required, and Kite evaluates the condition against its own feed
      // regardless — a client-supplied value is decorative at best and wrong at
      // worst, and needing one is what used to make this command depend on a
      // quote endpoint that not every API key may call.
    },
    orders: legs.map((leg) => ({
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      transaction_type: side as TransactionType,
      quantity: qty,
      order_type: orderType,
      product,
      // Kite keeps `price` on the wire for a MARKET order and stores it as 0.
      price: leg.price ?? 0,
      // What Kite itself writes for a market GTT: -1 is "use the exchange
      // default" for how far a triggered market order may slip.
      ...(orderType === 'MARKET' ? { market_protection: -1 } : {}),
    })),
  };

  // A MARKET order has no limit price, so the trigger is the best reference we
  // have — the price level at which the order is born. Falling back to the 0 we
  // send on the wire would read as "tiny order" to both the value cap and the
  // confirmation threshold, which is precisely backwards.
  const notionalValue = Math.max(...legs.map((leg) => leg.price ?? leg.trigger)) * qty;

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
      // Only shown when the user supplied one, and labelled as theirs: the CLI
      // has no price of its own to offer and must not appear to.
      ...(lastPrice !== undefined
        ? [{ label: 'Last price', value: `${rupees(lastPrice)} ${ctx.io.dim('(supplied with --last-price)')}` }]
        : []),
      // Displayed by name in Kite's own order, not in the order they go on the
      // wire: which leg is which is the thing being confirmed.
      ...displayOrder(legs).map((leg) => ({
        label: leg.label,
        value:
          orderType === 'MARKET'
            ? `trigger at ${rupees(leg.trigger)} → ${ctx.io.yellow('MARKET')}`
            : `trigger at ${rupees(leg.trigger)} → LIMIT ${rupees(leg.price!)}`,
      })),
      { label: 'Product', value: product },
      {
        // Only a LIMIT GTT has a genuine ceiling; at market the figure is an
        // estimate off the trigger, and saying so is the point.
        label: orderType === 'MARKET' ? 'Est. value' : 'Max value',
        value:
          orderType === 'MARKET'
            ? `${rupees(notionalValue)} ${ctx.io.dim('— a MARKET order fills at whatever the book offers when it triggers')}`
            : rupees(notionalValue),
      },
    ],
  });

  if (ctx.options.dryRun) return;

  const result = await ctx.api.placeGtt(params, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(result);
    return;
  }
  ctx.io.success(`GTT created: ${ctx.io.bold(String(result.trigger_id))}`);
  ctx.io.info(
    DERIVATIVE_EXCHANGES.has(instrument.exchange)
      ? 'GTT triggers on a derivative expire with the contract — check `kite gtt get` for the date.'
      : 'GTT triggers expire after one year, or when Kite invalidates them.',
  );
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

interface GttLeg {
  /** 'Stoploss' | 'Target' for an OCO, 'Trigger' for a single. */
  label: string;
  trigger: number;
  /** Undefined at market. */
  price?: number;
}

type PlaceOpts = {
  trigger: string[];
  price?: string;
  stoploss?: string;
  target?: string;
  stoplossPrice?: string;
  targetPrice?: string;
  orderType?: string;
};

/**
 * Decide whether this is a single trigger or an OCO, and refuse anything that
 * is neither cleanly.
 *
 * An OCO is named — `--stoploss` and `--target` — rather than positional,
 * because Kite only accepts a two-leg GTT with one trigger either side of the
 * current price, and which is which follows from the side. Two `--trigger`
 * values could only ever express the same thing while leaving the caller to
 * encode the array order, so that spelling is refused outright.
 */
function assertShapeIsCoherent(opts: PlaceOpts): boolean {
  const wantsOco = opts.stoploss !== undefined || opts.target !== undefined;
  const ocoFlags = 'Describe an OCO with --stoploss <price> and --target <price>.';

  if (opts.trigger.length > 1) {
    throw new UsageError('An OCO is not two --trigger values.', ocoFlags);
  }
  if (wantsOco && opts.trigger.length > 0) {
    throw new UsageError('--trigger is for a single-leg GTT and cannot be combined with --stoploss/--target.');
  }
  if (wantsOco && (opts.stoploss === undefined || opts.target === undefined)) {
    throw new UsageError(
      `An OCO needs both legs, but only --${opts.stoploss === undefined ? 'target' : 'stoploss'} was given.`,
      ocoFlags,
    );
  }
  if (!wantsOco && opts.trigger.length === 0) {
    throw new UsageError(`A GTT needs a trigger. ${ocoFlags}`, 'For a single trigger, pass --trigger <price>.');
  }

  // Cross-shape price flags: silently ignoring one would price a leg the user
  // believes they priced.
  if (wantsOco && opts.price !== undefined) {
    throw new UsageError(
      '--price is for a single-leg GTT.',
      'An OCO prices each leg separately: --stoploss-price and --target-price.',
    );
  }
  if (!wantsOco && (opts.stoplossPrice !== undefined || opts.targetPrice !== undefined)) {
    throw new UsageError('--stoploss-price/--target-price belong to an OCO.', 'A single-leg GTT takes one --price.');
  }

  return wantsOco;
}

/**
 * Resolve the order type for the whole GTT.
 *
 * Kite web offers Limit or Market for the trigger as a whole rather than per
 * leg, and this follows it. A supplied limit price implies LIMIT, since a price
 * cannot make an order less bounded — but MARKET is never inferred from the
 * absence of one. A forgotten or mistyped price flag turning into a market
 * order is the one failure this command must not have.
 */
function resolveOrderType(opts: PlaceOpts, isOco: boolean): GttOrderType {
  const prices = isOco ? [opts.stoplossPrice, opts.targetPrice] : [opts.price];
  const priced = prices.filter((price) => price !== undefined);

  const requested = opts.orderType === undefined ? undefined : normaliseGttOrderType(opts.orderType);
  const orderType = requested ?? (priced.length > 0 ? 'LIMIT' : undefined);

  if (orderType === undefined) {
    throw new UsageError(
      'No limit price was given, so the order type has to be explicit.',
      isOco
        ? 'Pass --order-type MARKET, or supply --stoploss-price and --target-price.'
        : 'Pass --order-type MARKET, or supply --price.',
    );
  }
  if (orderType === 'MARKET' && priced.length > 0) {
    throw new UsageError('A limit price cannot be used with --order-type MARKET.');
  }
  if (orderType === 'LIMIT' && priced.length !== prices.length) {
    throw new UsageError(
      isOco ? 'A LIMIT OCO needs a price for both legs.' : 'A LIMIT GTT needs a price.',
      isOco ? 'Pass --stoploss-price and --target-price.' : 'Pass --price <price>.',
    );
  }
  return orderType;
}

function resolveSingleLeg(opts: PlaceOpts, orderType: GttOrderType): GttLeg {
  return {
    label: 'Trigger',
    trigger: requirePrice(opts.trigger[0]!, '--trigger'),
    ...(orderType === 'LIMIT' ? { price: requirePrice(opts.price!, '--price') } : {}),
  };
}

/**
 * Build the two legs of an OCO, in the order they go on the wire.
 *
 * A BUY OCO closes a short: its stoploss is above the current price and its
 * target below. A SELL OCO closes a long, so the two swap. That is the whole
 * reason the legs can be named — the geometry follows from the side, and the
 * ascending order Kite index-matches to `orders` follows from the geometry.
 */
function resolveOcoLegs(
  opts: PlaceOpts,
  side: 'BUY' | 'SELL',
  orderType: GttOrderType,
  lastPrice: number | undefined,
): GttLeg[] {
  const stoplossIsAbove = side === 'BUY';

  const stoploss: GttLeg = {
    label: 'Stoploss',
    trigger: parseTrigger(opts.stoploss!, '--stoploss', stoplossIsAbove, lastPrice),
    ...(orderType === 'LIMIT' ? { price: requirePrice(opts.stoplossPrice!, '--stoploss-price') } : {}),
  };
  const target: GttLeg = {
    label: 'Target',
    trigger: parseTrigger(opts.target!, '--target', !stoplossIsAbove, lastPrice),
    ...(orderType === 'LIMIT' ? { price: requirePrice(opts.targetPrice!, '--target-price') } : {}),
  };

  if (stoploss.trigger === target.trigger) {
    throw new UsageError(`--stoploss and --target are both ${rupees(stoploss.trigger)}.`);
  }

  // Only checkable against a reference price, which is optional. Without one,
  // Kite decides — it evaluates the condition against its own feed anyway, and
  // inventing a price to check against would be a guess dressed as a guard.
  if (lastPrice !== undefined) {
    assertOnExpectedSide(stoploss, stoplossIsAbove, lastPrice, side);
    assertOnExpectedSide(target, !stoplossIsAbove, lastPrice, side);
  }

  return sortForWire([stoploss, target]);
}

function assertOnExpectedSide(leg: GttLeg, expectAbove: boolean, lastPrice: number, side: 'BUY' | 'SELL'): void {
  const isAbove = leg.trigger > lastPrice;
  if (isAbove === expectAbove) return;

  const closes = side === 'BUY' ? 'closes a short' : 'closes a long';
  throw new UsageError(
    `A ${side} OCO ${closes}, so its ${leg.label.toLowerCase()} must be ${expectAbove ? 'above' : 'below'} ${rupees(lastPrice)}, not ${isAbove ? 'above' : 'below'}.`,
    `Kite would reject this as "Condition already met" — the leg would fire the moment it was created.`,
  );
}

/**
 * `trigger_values` is index-matched to `orders`, and Kite wants the pair
 * ascending. Sorting here is safe precisely because the legs are named: each
 * leg carries its own price, so reordering cannot separate a trigger from it.
 */
function sortForWire(legs: GttLeg[]): GttLeg[] {
  return [...legs].sort((a, b) => a.trigger - b.trigger);
}

/** Stoploss before target, as Kite web lists them, whatever the wire order. */
function displayOrder(legs: GttLeg[]): GttLeg[] {
  return [...legs].sort((a, b) => (a.label === 'Stoploss' ? -1 : b.label === 'Stoploss' ? 1 : 0));
}

/**
 * A trigger is either an absolute price or a distance from the last price, as
 * in the "% of LTP" field of Kite web's own dialog.
 *
 * The percentage is unsigned: which way to move follows from the leg and the
 * side, so there is no sign for the user to get backwards.
 */
function parseTrigger(value: string, flag: string, above: boolean, lastPrice: number | undefined): number {
  if (!value.trim().endsWith('%')) return requirePrice(value, flag);

  const percent = Number(value.trim().slice(0, -1));
  if (!Number.isFinite(percent) || percent <= 0) {
    throw new UsageError(`${flag} must be a positive percentage, like 2%.`);
  }
  if (lastPrice === undefined) {
    throw new UsageError(
      `${flag} is a percentage, which is measured from the last price.`,
      'Pass --last-price <price>, or give an absolute trigger price.',
    );
  }
  // Two decimals is as fine as any Indian exchange quotes; Kite validates the
  // tick size itself when the order is actually placed.
  return Math.round(lastPrice * (above ? 1 + percent / 100 : 1 - percent / 100) * 100) / 100;
}

function normaliseGttOrderType(value: string): GttOrderType {
  const upper = value.toUpperCase();
  if ((GTT_ORDER_TYPES as string[]).includes(upper)) return upper as GttOrderType;
  throw new UsageError(
    `Unknown GTT order type "${value}".`,
    `A GTT places either of ${GTT_ORDER_TYPES.join(' or ')}; stop-loss types make no sense when the trigger is the stop.`,
  );
}

/**
 * CNC is the equity-delivery product and this command's default, so it is what
 * a derivatives GTT silently inherits when --product is forgotten — which is
 * never what was meant on a futures or options contract.
 */
function normaliseProduct(value: string | undefined, exchange: string): Product {
  if (value === undefined) {
    if (DERIVATIVE_EXCHANGES.has(exchange)) {
      throw new UsageError(
        `--product is required on ${exchange}.`,
        'CNC, the default, is an equity-delivery product. Pass --product NRML to carry the position, or MIS for intraday.',
      );
    }
    return 'CNC';
  }
  const upper = value.toUpperCase();
  if ((PRODUCTS as string[]).includes(upper)) return upper as Product;
  throw new UsageError(`Unknown product "${value}".`, `Valid products: ${PRODUCTS.join(', ')}.`);
}

function renderTableFor<T>(ctx: Context, rows: readonly T[], columns: Array<Column<T>>): string {
  return renderTable(ctx.io, rows, columns, {
    compact: ctx.config.output.compact,
  });
}
