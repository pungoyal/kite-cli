import { z } from 'zod';
import type { Context } from '../context.js';
import {
  ALERT_DEFAULT_ATTRIBUTE,
  ALERT_OPERATORS,
  type AlertBasket,
  type AlertOperator,
  type AlertParams,
  type AlertType,
  ORDER_TYPES,
  type OrderType,
  PRODUCTS,
  type Product,
  type TransactionType,
  VALIDITIES,
  type Validity,
} from '../core/api.js';
import { UsageError } from '../core/errors.js';
import { formatInstrumentKey, parseInstrumentKey } from '../core/instruments.js';
import type { Alert, AlertHistoryEntry } from '../core/schemas.js';
import { dateTime, money, quantity, rupees } from '../output/format.js';
import { type Column, heading, printTable, renderKeyValue, renderTable } from '../output/table.js';
import { assertTradingEnabled, confirmAction } from '../safety.js';
import type { CommandFactory } from './types.js';

/**
 * Price alerts.
 *
 * Two shapes:
 *   simple — fires a notification when a condition (e.g. LTP >= 27000) is met.
 *            No order, no money moves; treated like a watchlist entry.
 *   ato    — Alert-Triggers-Order: carries a basket that is placed as a real
 *            order when the alert fires. Creating one is order placement in
 *            disguise, so it gets the same safety treatment as `orders place`.
 */
export const alertCommands: CommandFactory = (program, run) => {
  const alerts = program.command('alerts').description('Manage price alerts');

  alerts
    .command('list', { isDefault: true })
    .description('Show your alerts')
    .option('--enabled', 'Show only enabled alerts')
    .option('--disabled', 'Show only disabled alerts')
    .action(run(listAlerts));

  alerts.command('get').description('Show one alert in detail').argument('<uuid>').action(run(getAlert));

  alerts.command('history').description("Show an alert's trigger history").argument('<uuid>').action(run(alertHistory));

  alerts
    .command('create')
    .description('Create a price alert')
    .argument('<instrument>', 'Instrument to watch, as EXCHANGE:SYMBOL (e.g. INDICES:NIFTY 50)')
    .requiredOption('-o, --operator <op>', 'Condition: >=, <=, >, <, == (aliases: above, below, ge, le, gt, lt, eq)')
    .option('--value <n>', 'Threshold to compare against (a constant)')
    .option('--rhs-instrument <instrument>', 'Compare against another instrument instead of a constant')
    .option('--name <name>', 'Alert name (defaults to a description of the condition)')
    .option('--attribute <attribute>', 'Attribute to compare', ALERT_DEFAULT_ATTRIBUTE)
    .option('--type <type>', 'simple or ato (ato places an order when it fires)', 'simple')
    // ATO order flags — mirror `orders place`. Only read when --type ato.
    .option('-s, --side <side>', 'ATO: order side, BUY or SELL')
    .option('-q, --quantity <n>', 'ATO: order quantity')
    .option('--order-type <type>', `ATO: order type (${ORDER_TYPES.join(', ')})`, 'MARKET')
    .option('-p, --price <price>', 'ATO: limit price (for LIMIT/SL orders)')
    .option('--trigger-price <price>', 'ATO: trigger price (for SL/SL-M orders)')
    .option('--product <product>', `ATO: product (${PRODUCTS.join(', ')})`, 'CNC')
    .option('--validity <validity>', `ATO: validity (${VALIDITIES.join(', ')})`, 'DAY')
    .action(run(createAlert));

  alerts
    .command('modify')
    .description('Modify an existing alert')
    .argument('<uuid>')
    .option('-o, --operator <op>', 'New condition operator')
    .option('--value <n>', 'New threshold constant')
    .option('--name <name>', 'New alert name')
    .action(run(modifyAlert));

  alerts
    .command('delete')
    .description('Delete one or more alerts')
    .argument('<uuid...>', 'One or more alert UUIDs')
    .action(run(deleteAlerts));
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function listAlerts(ctx: Context, opts: { enabled?: boolean; disabled?: boolean }): Promise<void> {
  ctx.requireSession();
  const all = await ctx.api.getAlerts(ctx.signal);
  let rows = all;
  if (opts.enabled) rows = rows.filter((a) => a.status === 'enabled');
  if (opts.disabled) rows = rows.filter((a) => a.status === 'disabled');

  const columns: Array<Column<Alert>> = [
    { header: 'UUID', value: (a, io) => io.dim(a.uuid) },
    { header: 'Name', value: (a, io) => io.bold(a.name ?? '—') },
    { header: 'Type', value: (a) => (a.type === 'ato' ? 'ATO' : 'simple') },
    { header: 'Condition', value: (a) => describeCondition(a) },
    { header: 'Status', value: (a, io) => colourAlertStatus(io, a.status) },
    { header: 'Fired', value: (a) => quantity(a.alert_count ?? 0), align: 'right' },
  ];

  printTable(ctx.io, rows, columns, rows, {
    compact: ctx.config.output.compact,
    empty: opts.enabled || opts.disabled ? 'No matching alerts.' : 'No alerts.',
  });
}

function colourAlertStatus(io: Context['io'], status: string): string {
  switch (status) {
    case 'enabled':
      return io.green(status);
    case 'disabled':
      return io.yellow(status);
    case 'deleted':
      return io.dim(status);
    default:
      return status;
  }
}

/** Render the alert's condition as a human-readable expression. */
function describeCondition(a: Alert): string {
  const lhs = `${a.lhs_exchange ?? '?'}:${a.lhs_tradingsymbol ?? '?'}`;
  const op = a.operator ?? '?';
  const rhs =
    a.rhs_type === 'instrument' ? `${a.rhs_exchange ?? '?'}:${a.rhs_tradingsymbol ?? '?'}` : money(a.rhs_constant);
  return `${lhs} ${op} ${rhs}`;
}

async function getAlert(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const uuid = requireUuid(command.args[0]);
  const alert = await ctx.api.getAlert(uuid, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(alert);
    return;
  }

  const { io } = ctx;
  io.line(heading(io, `Alert ${alert.name ?? alert.uuid}`));
  io.line(
    renderKeyValue(io, [
      ['UUID', alert.uuid],
      ['Type', alert.type === 'ato' ? 'ATO (places an order)' : 'simple'],
      ['Status', colourAlertStatus(io, alert.status)],
      ...(alert.disabled_reason ? [['Disabled reason', alert.disabled_reason] as [string, string]] : []),
      ['Condition', describeCondition(alert)],
      ['Attribute', alert.lhs_attribute ?? '—'],
      ['Times fired', quantity(alert.alert_count ?? 0)],
      ['Created', dateTime(alert.created_at)],
      ['Updated', dateTime(alert.updated_at)],
    ]),
  );

  const items = alert.basket?.items ?? [];
  if (items.length > 0) {
    io.line(heading(io, 'Order basket'));
    io.line(
      renderTableFor(ctx, items, [
        { header: 'Symbol', value: (i, io) => io.bold(`${i.exchange ?? '?'}:${i.tradingsymbol ?? '?'}`) },
        {
          header: 'Side',
          value: (i, io) => {
            const side = (i.params as { transaction_type?: string } | undefined)?.transaction_type;
            return side === 'BUY' ? io.green('BUY') : side === 'SELL' ? io.red('SELL') : '—';
          },
        },
        {
          header: 'Qty',
          value: (i) => quantity((i.params as { quantity?: number } | undefined)?.quantity),
          align: 'right',
        },
        { header: 'Type', value: (i) => (i.params as { order_type?: string } | undefined)?.order_type ?? '—' },
        {
          header: 'Price',
          value: (i) => money((i.params as { price?: number } | undefined)?.price),
          align: 'right',
        },
        { header: 'Product', value: (i) => (i.params as { product?: string } | undefined)?.product ?? '—' },
      ]),
    );
  }
}

async function alertHistory(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const uuid = requireUuid(command.args[0]);
  const history = await ctx.api.getAlertHistory(uuid, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(history);
    return;
  }

  const columns: Array<Column<AlertHistoryEntry>> = [
    { header: 'When', value: (h) => dateTime(h.created_at) },
    { header: 'Condition', value: (h) => h.condition ?? '—' },
    { header: 'Order', value: (h, io) => (h.order_meta ? io.green('placed') : io.dim('—')) },
  ];

  printTable(ctx.io, history, columns, history, {
    compact: ctx.config.output.compact,
    empty: 'This alert has never fired.',
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Re-validate Commander's untyped opts at runtime. Same reasoning as
 * `orders place`: the `.option()` declarations aren't checked against this
 * shape, so we turn the type lie into a runtime guarantee before an alert that
 * can place an order is built from it.
 */
const CreateOptionsSchema = z.object({
  operator: z.string(),
  value: z.coerce.number().optional(),
  rhsInstrument: z.string().optional(),
  name: z.string().optional(),
  attribute: z.string().default(ALERT_DEFAULT_ATTRIBUTE),
  type: z.string().default('simple'),
  side: z.string().optional(),
  quantity: z.coerce.number().int().positive().optional(),
  orderType: z.string().default('MARKET'),
  price: z.coerce.number().positive().optional(),
  triggerPrice: z.coerce.number().positive().optional(),
  product: z.string().default('CNC'),
  validity: z.string().default('DAY'),
});

async function createAlert(ctx: Context, rawOpts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();

  const parsed = CreateOptionsSchema.safeParse(rawOpts);
  if (!parsed.success) {
    throw new UsageError(`Invalid options:\n${z.prettifyError(parsed.error)}`);
  }
  const opts = parsed.data;

  const instrumentArg = command.args[0];
  if (!instrumentArg)
    throw new UsageError('An instrument to watch is required, e.g. `kite alerts create NSE:INFY ...`.');
  const lhs = parseInstrumentKey(instrumentArg);

  const operator = normaliseOperator(opts.operator);
  const type = normaliseType(opts.type);

  // Right-hand side: a constant OR another instrument, never both.
  if (opts.value !== undefined && opts.rhsInstrument !== undefined) {
    throw new UsageError('Use either --value or --rhs-instrument, not both.');
  }

  const params: AlertParams = {
    name: opts.name ?? defaultAlertName(lhs.tradingsymbol, operator, opts),
    type,
    lhs_exchange: lhs.exchange,
    lhs_tradingsymbol: lhs.tradingsymbol,
    lhs_attribute: opts.attribute,
    operator,
    rhs_type: 'constant',
  };

  let conditionValue: string;
  if (opts.rhsInstrument !== undefined) {
    const rhs = parseInstrumentKey(opts.rhsInstrument);
    params.rhs_type = 'instrument';
    params.rhs_exchange = rhs.exchange;
    params.rhs_tradingsymbol = rhs.tradingsymbol;
    params.rhs_attribute = opts.attribute;
    conditionValue = formatInstrumentKey(rhs.exchange, rhs.tradingsymbol);
  } else {
    if (opts.value === undefined) {
      throw new UsageError('A threshold is required. Pass --value <n> or --rhs-instrument <EXCHANGE:SYMBOL>.');
    }
    params.rhs_constant = opts.value;
    conditionValue = rupees(opts.value);
  }

  const lhsKey = formatInstrumentKey(lhs.exchange, lhs.tradingsymbol);
  const details = [
    { label: 'Watch', value: lhsKey },
    { label: 'Condition', value: `${opts.attribute} ${operator} ${conditionValue}` },
    { label: 'Name', value: params.name },
    { label: 'Type', value: type === 'ato' ? ctx.io.yellow('ATO — places an order when it fires') : 'simple' },
  ];

  if (type === 'ato') {
    // ATO creation IS order placement: it needs the kill switch, the value cap,
    // and the full escalating confirmation, exactly like `orders place`.
    assertTradingEnabled(ctx);
    const { basket, notionalValue, orderDetails } = await buildAtoBasket(ctx, opts, lhs);
    params.basket = basket;

    await confirmAction(ctx, {
      action: `Create ATO alert on ${lhsKey}`,
      mutatesOrders: true,
      increasesExposure: true,
      notionalValue,
      challengeToken: lhs.tradingsymbol,
      details: [...details, ...orderDetails],
    });
  } else {
    // A simple alert moves no money — no kill switch, no value cap, no typed
    // challenge. Just show what will be created and take a plain confirmation.
    await confirmAction(ctx, {
      action: `Create alert on ${lhsKey}`,
      details,
    });
  }

  if (ctx.options.dryRun) return;

  const result = await ctx.api.createAlert(params, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(result);
    return;
  }
  ctx.io.success(`Alert created: ${ctx.io.bold(result.uuid)}`);
  if (type === 'ato') {
    ctx.io.info(
      'When this fires, Kite places the order in the basket. Acceptance is not execution — check `kite orders list`.',
    );
  }
}

/**
 * Build the single-order basket for an ATO alert from the order flags, and
 * price it for the value cap.
 *
 * Returns the notional as UNDEFINED when it cannot be priced, so the safety
 * layer fails closed (escalates to a typed challenge) rather than treating an
 * unknown value as small.
 */
async function buildAtoBasket(
  ctx: Context,
  opts: z.infer<typeof CreateOptionsSchema>,
  lhs: { exchange: string; tradingsymbol: string },
): Promise<{
  basket: AlertBasket;
  notionalValue: number | undefined;
  orderDetails: Array<{ label: string; value: string }>;
}> {
  if (!opts.side) throw new UsageError('--side (BUY or SELL) is required for an ATO alert.');
  if (opts.quantity === undefined) throw new UsageError('--quantity is required for an ATO alert.');

  const side = opts.side.toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new UsageError('--side must be BUY or SELL.');

  const orderType = normalise(opts.orderType, ORDER_TYPES, 'order type') as OrderType;
  const product = normalise(opts.product, PRODUCTS, 'product') as Product;
  const validity = normalise(opts.validity, VALIDITIES, 'validity') as Validity;

  if ((orderType === 'LIMIT' || orderType === 'SL') && opts.price === undefined) {
    throw new UsageError(`--price is required for a ${orderType} order.`);
  }
  if ((orderType === 'SL' || orderType === 'SL-M') && opts.triggerPrice === undefined) {
    throw new UsageError(`--trigger-price is required for a ${orderType} order.`);
  }
  if (orderType === 'MARKET' && opts.price !== undefined) {
    throw new UsageError('--price cannot be used with a MARKET order.');
  }

  // The ATO order trades the LHS (watched) instrument.
  const instrumentKey = formatInstrumentKey(lhs.exchange, lhs.tradingsymbol);

  // Price for the value cap. An explicit limit price is authoritative; otherwise
  // fall back to the last traded price, leaving it undefined if that fails.
  let referencePrice = opts.price;
  if (referencePrice === undefined) {
    try {
      const ltp = await ctx.api.getLtp([instrumentKey], ctx.signal);
      referencePrice = ltp[instrumentKey]?.last_price;
    } catch {
      // Quote bucket is 1/sec; a 429 here is routine. Leave undefined.
    }
  }
  if (referencePrice === undefined) {
    ctx.io.warn(`Could not fetch a price for ${instrumentKey}; this alert's order value cannot be estimated.`);
  }
  const notionalValue = referencePrice !== undefined ? referencePrice * opts.quantity : undefined;

  const basket: AlertBasket = {
    name: 'kite-cli-alert',
    type: 'alert',
    tags: [],
    items: [
      {
        type: 'insert',
        tradingsymbol: lhs.tradingsymbol,
        exchange: lhs.exchange,
        // Documented baskets use 10000 (a full-allocation weight) for a single
        // item; we follow the docs rather than invent a value.
        weight: 10000,
        params: {
          transaction_type: side as TransactionType,
          order_type: orderType,
          product,
          validity,
          quantity: opts.quantity,
          price: opts.price ?? 0,
          trigger_price: opts.triggerPrice ?? 0,
          variety: 'regular',
        },
      },
    ],
  };

  const orderDetails = [
    {
      label: 'Order',
      value: `${side === 'BUY' ? ctx.io.green(side) : ctx.io.red(side)} ${quantity(opts.quantity)} ${lhs.tradingsymbol}`,
    },
    { label: 'Order type', value: orderType },
    ...(opts.price !== undefined ? [{ label: 'Price', value: rupees(opts.price) }] : []),
    ...(opts.triggerPrice !== undefined ? [{ label: 'Trigger', value: rupees(opts.triggerPrice) }] : []),
    { label: 'Product', value: product },
    { label: 'Validity', value: validity },
    {
      label: 'Est. order value',
      value: notionalValue !== undefined ? rupees(notionalValue) : ctx.io.dim('unknown (no quote available)'),
    },
  ];

  return { basket, notionalValue, orderDetails };
}

// ---------------------------------------------------------------------------
// Modify
// ---------------------------------------------------------------------------

async function modifyAlert(
  ctx: Context,
  opts: { operator?: string; value?: string; name?: string },
  command: { args: string[] },
): Promise<void> {
  ctx.requireSession();
  const uuid = requireUuid(command.args[0]);

  if (opts.operator === undefined && opts.value === undefined && opts.name === undefined) {
    throw new UsageError('Nothing to modify. Pass at least one of --operator, --value or --name.');
  }

  // Kite's PUT replaces the whole alert, so we start from the current one and
  // overlay the changes — including carrying the existing ATO basket through
  // untouched, which is why we read it back rather than reconstructing it.
  const existing = await ctx.api.getAlert(uuid, ctx.signal);

  const type = existing.type === 'ato' ? 'ato' : ('simple' as AlertType);
  const operator =
    opts.operator !== undefined ? normaliseOperator(opts.operator) : (existing.operator as AlertOperator);
  if (!operator || !(ALERT_OPERATORS as readonly string[]).includes(operator)) {
    throw new UsageError('This alert has no valid operator to keep; pass --operator explicitly.');
  }

  const rhsType = existing.rhs_type === 'instrument' ? 'instrument' : 'constant';
  const params: AlertParams = {
    name: opts.name ?? existing.name ?? describeCondition(existing),
    type,
    lhs_exchange: existing.lhs_exchange ?? '',
    lhs_tradingsymbol: existing.lhs_tradingsymbol ?? '',
    lhs_attribute: existing.lhs_attribute ?? ALERT_DEFAULT_ATTRIBUTE,
    operator,
    rhs_type: rhsType,
  };

  if (rhsType === 'instrument') {
    params.rhs_exchange = existing.rhs_exchange;
    params.rhs_tradingsymbol = existing.rhs_tradingsymbol;
    params.rhs_attribute = existing.rhs_attribute ?? ALERT_DEFAULT_ATTRIBUTE;
  } else {
    if (opts.value !== undefined) {
      const value = Number(opts.value);
      if (!Number.isFinite(value)) throw new UsageError('--value must be a number.');
      params.rhs_constant = value;
    } else {
      params.rhs_constant = existing.rhs_constant;
    }
  }

  if (existing.basket) {
    // Carry the ATO order through unchanged. The basket read back has richer
    // fields than we send, but Kite accepts the round-trip.
    params.basket = existing.basket as unknown as AlertBasket;
  }

  const before = describeCondition(existing);
  const after = describeCondition({ ...existing, operator, rhs_constant: params.rhs_constant });

  await confirmAction(ctx, {
    action: `Modify alert ${existing.name ?? uuid}`,
    // An ATO alert carries an order; modifying its trigger changes when that
    // order fires, so apply the trading guard rails as for creation.
    mutatesOrders: type === 'ato',
    details: [
      { label: 'UUID', value: uuid },
      { label: 'Condition', value: before === after ? before : `${before} → ${after}` },
      ...(opts.name !== undefined ? [{ label: 'Name', value: `${existing.name ?? '—'} → ${params.name}` }] : []),
    ],
  });

  if (ctx.options.dryRun) return;

  const result = await ctx.api.modifyAlert(uuid, params, ctx.signal);
  if (ctx.io.json) {
    ctx.io.writeJson(result);
    return;
  }
  ctx.io.success(`Alert ${result.uuid} modified.`);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function deleteAlerts(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const uuids = command.args.map((arg) => requireUuid(arg));
  if (uuids.length === 0) throw new UsageError('At least one alert UUID is required.');

  // Enrichment for the preview. A failed lookup must not block deletion —
  // removing an alert only cancels a pending trigger — but the user is told the
  // details are unverified rather than shown a silent "unknown".
  const known = new Map<string, Alert>();
  try {
    for (const alert of await ctx.api.getAlerts(ctx.signal)) known.set(alert.uuid, alert);
  } catch {
    ctx.io.warn('Could not read your alerts from Kite; the details below are unverified.');
  }

  await confirmAction(ctx, {
    action: uuids.length === 1 ? `Delete alert ${uuids[0]}` : `Delete ${uuids.length} alerts`,
    details: uuids.map((uuid) => {
      const alert = known.get(uuid);
      return {
        label: alert?.name ?? uuid,
        value: alert ? `${describeCondition(alert)} (${alert.status})` : ctx.io.dim('unverified'),
      };
    }),
  });

  if (ctx.options.dryRun) return;

  const result = await ctx.api.deleteAlerts(uuids, ctx.signal);
  if (ctx.io.json) {
    ctx.io.writeJson(result ?? { deleted: uuids });
    return;
  }
  ctx.io.success(uuids.length === 1 ? `Alert ${uuids[0]} deleted.` : `${uuids.length} alerts deleted.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Alert IDs are UUID strings, not the numeric ids GTT and orders use. */
function requireUuid(value: string | undefined): string {
  const uuid = value?.trim();
  if (!uuid) throw new UsageError('An alert UUID is required.');
  return uuid;
}

function normaliseType(value: string): AlertType {
  const lower = value.toLowerCase();
  if (lower === 'simple' || lower === 'ato') return lower;
  throw new UsageError(`Unknown alert type "${value}".`, 'Valid types: simple, ato.');
}

const OPERATOR_ALIASES: Record<string, AlertOperator> = {
  '>=': '>=',
  ge: '>=',
  above: '>=',
  over: '>=',
  '<=': '<=',
  le: '<=',
  below: '<=',
  under: '<=',
  '>': '>',
  gt: '>',
  '<': '<',
  lt: '<',
  '==': '==',
  '=': '==',
  eq: '==',
};

function normaliseOperator(value: string): AlertOperator {
  const op = OPERATOR_ALIASES[value.toLowerCase()] ?? OPERATOR_ALIASES[value];
  if (!op) {
    throw new UsageError(
      `Unknown operator "${value}".`,
      'Valid operators: >=, <=, >, <, == (aliases: above, below, ge, le, gt, lt, eq).',
    );
  }
  return op;
}

function defaultAlertName(symbol: string, operator: AlertOperator, opts: z.infer<typeof CreateOptionsSchema>): string {
  const rhs = opts.rhsInstrument ?? (opts.value !== undefined ? String(opts.value) : '');
  return `${symbol} ${operator} ${rhs}`.trim().slice(0, 100);
}

function normalise(value: string, allowed: readonly string[], label: string): string {
  const candidate = value.toUpperCase();
  if (allowed.includes(candidate)) return candidate;
  throw new UsageError(`Unknown ${label} "${value}".`, `Valid values: ${allowed.join(', ')}.`);
}

function renderTableFor<T>(ctx: Context, rows: readonly T[], columns: Array<Column<T>>): string {
  return renderTable(ctx.io, rows, columns, {
    compact: ctx.config.output.compact,
  });
}
