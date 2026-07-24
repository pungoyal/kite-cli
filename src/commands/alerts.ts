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
import { ExitCode, KiteCliError, UsageError } from '../core/errors.js';
import { formatInstrumentKey, parseInstrumentKey } from '../core/instruments.js';
import type { Alert, AlertHistoryEntry } from '../core/schemas.js';
import { dateTime, money, quantity, rupees } from '../output/format.js';
import { type Column, heading, printTable, renderKeyValue, renderTable } from '../output/table.js';
import { assertTradingEnabled, confirmAction } from '../safety.js';
import { examples } from './examples.js';
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
  const alerts = program
    .command('alerts')
    .description('Manage price alerts')
    .addHelpText(
      'after',
      examples([
        ['kite alerts', 'Your alerts and whether they are enabled'],
        ['kite alerts create NSE:INFY -o above --value 1800', 'Notify when INFY crosses ₹1,800'],
        ['kite alerts disable 5e3c2a1b-...', 'Silence one without deleting it'],
        ['kite alerts history 5e3c2a1b-...', 'When did it fire?'],
      ]),
    );

  alerts
    .command('list', { isDefault: true })
    .description('Show your alerts')
    .option('--enabled', 'Show only enabled alerts')
    .option('--disabled', 'Show only disabled alerts')
    .addHelpText(
      'after',
      examples([
        ['kite alerts', 'Every alert (list is the default)'],
        ['kite alerts list --enabled', 'Only alerts currently armed'],
        [`kite alerts list --json | jq -r '.[].uuid'`, 'Alert ids, for scripting'],
      ]),
    )
    .action(run(listAlerts));

  alerts
    .command('get')
    .description('Show one alert in detail')
    .argument('<uuid>')
    .addHelpText(
      'after',
      examples([['kite alerts get 5e3c2a1b-8f4d-4c2e-9a71-6b0d2f3c8e15', 'The full condition and any ATO basket']]),
    )
    .action(run(getAlert));

  alerts
    .command('history')
    .description("Show an alert's trigger history")
    .argument('<uuid>')
    .addHelpText(
      'after',
      examples([['kite alerts history 5e3c2a1b-8f4d-4c2e-9a71-6b0d2f3c8e15', 'Every time this alert has fired']]),
    )
    .action(run(alertHistory));

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
    // ATO basket. Two shapes, never mixed:
    //   --order  — a full basket leg, repeatable, each on its own instrument
    //              (independent of the watched one). This is how you place
    //              orders on a different symbol, or several at once.
    //   the flags below — a shorthand for a single order on the *watched*
    //              instrument, kept for back-compat.
    .option(
      '--order <spec>',
      'ATO: a basket leg as EXCHANGE:SYMBOL:SIDE:QTY[:TYPE][:PRICE][:PRODUCT][:VALIDITY][:trigger=<n>]. Repeatable.',
      collect,
      [] as string[],
    )
    // ATO single-order flags — a shorthand for one order on the watched
    // instrument. Read only when --type ato and no --order is given; combining
    // them with --order is a hard error, so they carry NO defaults here (a
    // default would be invisible to that guard and silently ignored).
    .option('-s, --side <side>', 'ATO: order side, BUY or SELL (single-order form)')
    .option('-q, --quantity <n>', 'ATO: order quantity (single-order form)')
    .option('--order-type <type>', `ATO: order type, default MARKET (${ORDER_TYPES.join(', ')}) (single-order form)`)
    .option('-p, --price <price>', 'ATO: limit price (single-order form; for LIMIT/SL)')
    .option('--trigger-price <price>', 'ATO: trigger price (single-order form; for SL/SL-M)')
    .option('--product <product>', `ATO: product, default CNC (${PRODUCTS.join(', ')}) (single-order form)`)
    .option('--validity <validity>', `ATO: validity, default DAY (${VALIDITIES.join(', ')}) (single-order form)`)
    .addHelpText(
      'after',
      `
A simple alert only notifies. An ATO alert places real orders when it fires:
either one order on the watched instrument (-s/-q/--order-type ...) or a basket
of --order legs on any instruments — never both forms at once.
${examples([
  ['kite alerts create NSE:INFY -o above --value 1800', 'Notify when INFY trades above ₹1,800'],
  ['kite alerts create "INDICES:NIFTY 50" -o below --value 24000', 'Watch an index'],
  [
    'kite alerts create NSE:INFY -o \\>= --value 1800 --name "book profit"',
    'Symbolic operators need escaping in most shells',
  ],
  ['kite alerts create NSE:INFY -o above --rhs-instrument NSE:TCS', 'Compare two instruments instead of a constant'],
  [
    'kite alerts create NSE:INFY -o below --value 1500 --type ato -s BUY -q 10',
    'ATO: buy 10 INFY at market when it drops below 1500',
  ],
  [
    'kite alerts create NSE:INFY -o below --value 1500 --type ato --order-type LIMIT -p 1495 -s BUY -q 10',
    'ATO with a limit price',
  ],
  [
    'kite alerts create "INDICES:NIFTY 50" -o below --value 24000 --type ato --order NFO:NIFTY25AUGFUT:SELL:75:MARKET:NRML',
    'ATO basket: sell futures off an index level — repeat --order for more legs',
  ],
  ['kite alerts create NSE:INFY -o above --value 1800 --type ato -s SELL -q 10 --dry-run', 'Preview an ATO'],
])}`,
    )
    .action(run(createAlert));

  alerts
    .command('modify')
    .description('Modify an existing alert')
    .argument('<uuid>')
    .option('-o, --operator <op>', 'New condition operator')
    .option('--value <n>', 'New threshold constant')
    .option('--name <name>', 'New alert name')
    .addHelpText(
      'after',
      examples([
        ['kite alerts modify 5e3c2a1b-... --value 1900', 'Move the threshold'],
        ['kite alerts modify 5e3c2a1b-... -o below --value 1500', 'Flip the condition'],
        ['kite alerts modify 5e3c2a1b-... --name "exit signal"', 'Rename it'],
      ]),
    )
    .action(run(modifyAlert));

  alerts
    .command('enable')
    .description('Re-enable a disabled alert')
    .argument('<uuid>')
    .addHelpText('after', examples([['kite alerts enable 5e3c2a1b-...', 'Arm it again']]))
    .action(run(enableAlert));

  alerts
    .command('disable')
    .description('Disable an alert without deleting it')
    .argument('<uuid>')
    .addHelpText('after', examples([['kite alerts disable 5e3c2a1b-...', 'Keep the alert, stop it firing']]))
    .action(run(disableAlert));

  alerts
    .command('delete')
    .description('Delete one or more alerts')
    .argument('<uuid...>', 'One or more alert UUIDs')
    .addHelpText(
      'after',
      examples([
        ['kite alerts delete 5e3c2a1b-...', 'Delete one alert'],
        ['kite alerts delete 5e3c2a1b-... 7d1f4c9a-...', 'Delete several in one call'],
        [`kite alerts list --json | jq -r '.[].uuid' | xargs kite alerts delete -y`, 'Delete every alert'],
      ]),
    )
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
  order: z.array(z.string()).default([]),
  side: z.string().optional(),
  quantity: z.coerce.number().int().positive().optional(),
  // No defaults: these are single-order-form flags, and defaulting them would
  // make them undetectable to the guard that forbids mixing them with --order.
  orderType: z.string().optional(),
  price: z.coerce.number().positive().optional(),
  triggerPrice: z.coerce.number().positive().optional(),
  product: z.string().optional(),
  validity: z.string().optional(),
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
    const legs = resolveAtoLegs(opts, lhs);
    const { basket, notionalValue, orderDetails } = await buildAtoBasket(ctx, legs);
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

/** One order in an ATO basket, fully resolved and validated. */
export interface AtoLeg {
  exchange: string;
  tradingsymbol: string;
  side: TransactionType;
  quantity: number;
  orderType: OrderType;
  price: number | undefined;
  triggerPrice: number | undefined;
  product: Product;
  validity: Validity;
}

/**
 * Resolve the ATO basket's legs from the parsed options. The `--order` form
 * (one leg per flag, each on its own instrument) and the single-order flag form
 * are mutually exclusive: mixing them is a hard error rather than a silent
 * precedence rule, because the two describe different orders and a guessed
 * winner would place the wrong one.
 */
function resolveAtoLegs(
  opts: z.infer<typeof CreateOptionsSchema>,
  lhs: { exchange: string; tradingsymbol: string },
): AtoLeg[] {
  if (opts.order.length > 0) {
    const usedSingleFlags =
      opts.side !== undefined ||
      opts.quantity !== undefined ||
      opts.price !== undefined ||
      opts.triggerPrice !== undefined ||
      opts.orderType !== undefined ||
      opts.product !== undefined ||
      opts.validity !== undefined;
    if (usedSingleFlags) {
      throw new UsageError(
        'Use either --order (repeatable) or the single-order flags (--side/--quantity/--price/...), not both.',
      );
    }
    return opts.order.map(parseOrderSpec);
  }
  return [legFromFlags(opts, lhs)];
}

/** Build a single leg on the *watched* instrument from the shorthand flags. */
function legFromFlags(
  opts: z.infer<typeof CreateOptionsSchema>,
  lhs: { exchange: string; tradingsymbol: string },
): AtoLeg {
  if (!opts.side) throw new UsageError('--side (BUY or SELL) is required for an ATO alert (or use --order).');
  if (opts.quantity === undefined) throw new UsageError('--quantity is required for an ATO alert (or use --order).');

  const side = opts.side.toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new UsageError('--side must be BUY or SELL.');

  const orderType = normalise(opts.orderType ?? 'MARKET', ORDER_TYPES, 'order type') as OrderType;
  const product = normalise(opts.product ?? 'CNC', PRODUCTS, 'product') as Product;
  const validity = normalise(opts.validity ?? 'DAY', VALIDITIES, 'validity') as Validity;

  if ((orderType === 'LIMIT' || orderType === 'SL') && opts.price === undefined) {
    throw new UsageError(`--price is required for a ${orderType} order.`);
  }
  if ((orderType === 'SL' || orderType === 'SL-M') && opts.triggerPrice === undefined) {
    throw new UsageError(`--trigger-price is required for a ${orderType} order.`);
  }
  if (orderType === 'MARKET' && opts.price !== undefined) {
    throw new UsageError('--price cannot be used with a MARKET order.');
  }

  return {
    exchange: lhs.exchange,
    tradingsymbol: lhs.tradingsymbol,
    side: side as TransactionType,
    quantity: opts.quantity,
    orderType,
    price: opts.price,
    triggerPrice: opts.triggerPrice,
    product,
    validity,
  };
}

/**
 * Parse one `--order` spec into a leg.
 *
 * Grammar: `EXCHANGE:SYMBOL:SIDE:QTY` followed by any number of optional
 * attribute tokens. Each attribute is either a bare vocabulary word (an order
 * type, a product, a validity, or a number read as the price) or an explicit
 * `key=value` (type, product, validity, price, trigger).
 *
 * Fails closed (invariant #1): every trailing token must be classified exactly
 * once. An unrecognised token, a duplicated field, or an empty field rejects the
 * whole spec — a silently mis-parsed leg is a real order with the wrong
 * parameters. A trigger price is only ever set explicitly (`trigger=<n>`), never
 * positionally, so an SL order can't be misread from two bare numbers.
 */
export function parseOrderSpec(spec: string): AtoLeg {
  const raw = spec.trim();
  const tokens = raw.split(':').map((t) => t.trim());
  if (tokens.length < 4) {
    throw new UsageError(
      `Malformed --order "${spec}".`,
      'Expected at least EXCHANGE:SYMBOL:SIDE:QTY, e.g. NFO:INDIGO25AUGFUT:BUY:150:MARKET:NRML.',
    );
  }

  // Guaranteed present by the length check above.
  const [exchangeTok, symbolTok, sideTok, qtyTok, ...rest] = tokens as [string, string, string, string, ...string[]];
  const { exchange, tradingsymbol } = parseInstrumentKey(`${exchangeTok}:${symbolTok}`);

  const side = sideTok.toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') {
    throw new UsageError(`--order side must be BUY or SELL, got "${sideTok}" in "${spec}".`);
  }

  const quantity = Number(qtyTok);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new UsageError(`--order quantity must be a positive integer, got "${qtyTok}" in "${spec}".`);
  }

  let orderType: OrderType | undefined;
  let price: number | undefined;
  let triggerPrice: number | undefined;
  let product: Product | undefined;
  let validity: Validity | undefined;

  const setOnce = <T>(current: T | undefined, next: T, label: string): T => {
    if (current !== undefined) throw new UsageError(`--order "${spec}" sets ${label} more than once.`);
    return next;
  };

  for (const tok of rest) {
    if (tok === '') {
      throw new UsageError(`--order "${spec}" has an empty field. Remove the stray ":".`);
    }
    const eq = tok.indexOf('=');
    if (eq !== -1) {
      const key = tok.slice(0, eq).trim().toLowerCase();
      const value = tok.slice(eq + 1).trim();
      switch (key) {
        case 'type':
          orderType = setOnce(orderType, normalise(value, ORDER_TYPES, 'order type') as OrderType, 'the order type');
          break;
        case 'product':
          product = setOnce(product, normalise(value, PRODUCTS, 'product') as Product, 'the product');
          break;
        case 'validity':
          validity = setOnce(validity, normalise(value, VALIDITIES, 'validity') as Validity, 'the validity');
          break;
        case 'price':
          price = setOnce(price, parsePositive(value, 'price', spec), 'the price');
          break;
        case 'trigger':
          triggerPrice = setOnce(triggerPrice, parsePositive(value, 'trigger', spec), 'the trigger price');
          break;
        default:
          throw new UsageError(
            `--order "${spec}" has an unknown field "${key}".`,
            'Valid keys: type, price, trigger, product, validity.',
          );
      }
      continue;
    }

    const upper = tok.toUpperCase();
    if ((ORDER_TYPES as readonly string[]).includes(upper)) {
      orderType = setOnce(orderType, upper as OrderType, 'the order type');
    } else if ((PRODUCTS as readonly string[]).includes(upper)) {
      product = setOnce(product, upper as Product, 'the product');
    } else if ((VALIDITIES as readonly string[]).includes(upper)) {
      validity = setOnce(validity, upper as Validity, 'the validity');
    } else if (isNumeric(tok)) {
      // A bare number is always the price. A trigger must be given explicitly.
      price = setOnce(price, parsePositive(tok, 'price', spec), 'the price');
    } else {
      throw new UsageError(
        `--order "${spec}" has an unrecognised field "${tok}".`,
        'Fields after QTY are an order type, product, validity, a price, or trigger=<n>.',
      );
    }
  }

  const type = orderType ?? 'MARKET';
  if ((type === 'LIMIT' || type === 'SL') && price === undefined) {
    throw new UsageError(`--order "${spec}" is a ${type} order and needs a price.`);
  }
  if ((type === 'SL' || type === 'SL-M') && triggerPrice === undefined) {
    throw new UsageError(`--order "${spec}" is a ${type} order and needs trigger=<price>.`);
  }
  if (type === 'MARKET' && price !== undefined) {
    throw new UsageError(`--order "${spec}" is a MARKET order and cannot set a price.`);
  }

  return {
    exchange,
    tradingsymbol,
    side: side as TransactionType,
    quantity,
    orderType: type,
    price,
    triggerPrice,
    product: product ?? 'CNC',
    validity: validity ?? 'DAY',
  };
}

/**
 * Price every leg and assemble the basket for the value cap and confirmation.
 *
 * Returns the notional as UNDEFINED when *any* leg cannot be priced, so the
 * safety layer fails closed (escalates to a typed challenge) rather than
 * treating an unknown total as small. Legs without an explicit limit price are
 * quoted in a single batched LTP call.
 */
async function buildAtoBasket(
  ctx: Context,
  legs: AtoLeg[],
): Promise<{
  basket: AlertBasket;
  notionalValue: number | undefined;
  orderDetails: Array<{ label: string; value: string }>;
}> {
  // Quote every leg that has no explicit price, in one call (the quote bucket
  // is 1/sec, so N separate lookups would rate-limit).
  const needQuote = [
    ...new Set(legs.filter((l) => l.price === undefined).map((l) => formatInstrumentKey(l.exchange, l.tradingsymbol))),
  ];
  let ltp: Awaited<ReturnType<Context['api']['getLtp']>> = {};
  if (needQuote.length > 0) {
    try {
      ltp = await ctx.api.getLtp(needQuote, ctx.signal);
    } catch {
      // A 429 here is routine; leave legs unpriced so the cap fails closed.
    }
  }

  let notionalValue: number | undefined = 0;
  const items: AlertBasket['items'] = [];
  const orderDetails: Array<{ label: string; value: string }> = [];

  legs.forEach((leg, i) => {
    const key = formatInstrumentKey(leg.exchange, leg.tradingsymbol);
    const referencePrice = leg.price ?? ltp[key]?.last_price;
    if (referencePrice === undefined) {
      // One unpriceable leg voids the whole total — never sum around a gap.
      notionalValue = undefined;
      ctx.io.warn(`Could not fetch a price for ${key}; this alert's order value cannot be estimated.`);
    } else if (notionalValue !== undefined) {
      notionalValue += referencePrice * leg.quantity;
    }

    items.push({
      type: 'insert',
      tradingsymbol: leg.tradingsymbol,
      exchange: leg.exchange,
      // Documented single-item baskets use 10000 (a full-allocation weight). The
      // multi-item weighting is undocumented; params drive the actual order, so
      // we keep 10000 per leg rather than invent a split.
      weight: 10000,
      params: {
        transaction_type: leg.side,
        order_type: leg.orderType,
        product: leg.product,
        validity: leg.validity,
        quantity: leg.quantity,
        price: leg.price ?? 0,
        trigger_price: leg.triggerPrice ?? 0,
        variety: 'regular',
      },
    });

    const sideText = leg.side === 'BUY' ? ctx.io.green(leg.side) : ctx.io.red(leg.side);
    const bits = [`${leg.orderType}`, leg.product];
    if (leg.price !== undefined) bits.push(`@ ${rupees(leg.price)}`);
    if (leg.triggerPrice !== undefined) bits.push(`trigger ${rupees(leg.triggerPrice)}`);
    orderDetails.push({
      label: legs.length === 1 ? 'Order' : `Order ${i + 1}`,
      value: `${sideText} ${quantity(leg.quantity)} ${key} (${bits.join(', ')})`,
    });
  });

  orderDetails.push({
    label: legs.length === 1 ? 'Est. order value' : 'Est. total value',
    value: notionalValue !== undefined ? rupees(notionalValue) : ctx.io.dim('unknown (no quote available)'),
  });

  const basket: AlertBasket = { name: 'kite-cli-alert', type: 'alert', tags: [], items };
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

  const existing = await ctx.api.getAlert(uuid, ctx.signal);
  const params = alertParamsFromExisting(existing, {
    name: opts.name,
    operator: opts.operator !== undefined ? normaliseOperator(opts.operator) : undefined,
    value: opts.value,
  });

  const before = describeCondition(existing);
  const after = describeCondition({ ...existing, operator: params.operator, rhs_constant: params.rhs_constant });

  await confirmAction(ctx, {
    action: `Modify alert ${existing.name ?? uuid}`,
    // An ATO alert carries an order; modifying its trigger changes when that
    // order fires, so apply the trading guard rails as for creation.
    mutatesOrders: params.type === 'ato',
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

/**
 * Rebuild a full AlertParams from an existing alert — Kite's PUT replaces the
 * whole alert rather than patching fields, so every call site that modifies
 * one field still has to resend the rest unchanged (including carrying the
 * existing ATO basket through untouched; the basket read back has richer
 * fields than we send, but Kite accepts the round-trip).
 *
 * `overrides.value` only takes effect when the alert's right-hand side is a
 * constant — an instrument-referencing RHS has no threshold to overwrite, so
 * it is silently ignored there rather than rejected, matching the pre-existing
 * `modify` behaviour this was extracted from. `overrides.status` is used only
 * by `enable`/`disable`; `modify` never sets it, so its PUT calls carry no
 * `status` field, unchanged from before this helper existed.
 */
function alertParamsFromExisting(
  existing: Alert,
  overrides: { name?: string; operator?: AlertOperator; value?: string; status?: 'enabled' | 'disabled' } = {},
): AlertParams {
  const type = existing.type === 'ato' ? 'ato' : ('simple' as AlertType);
  const operator = overrides.operator ?? (existing.operator as AlertOperator);
  if (!operator || !(ALERT_OPERATORS as readonly string[]).includes(operator)) {
    // Shared by modify, enable and disable — none of which can assume the
    // others' flags exist, so point at a command rather than a specific flag.
    throw new UsageError(
      'This alert has no valid operator to keep.',
      'Run `kite alerts modify --operator <op>` to set one first.',
    );
  }

  const rhsType = existing.rhs_type === 'instrument' ? 'instrument' : 'constant';
  const params: AlertParams = {
    name: overrides.name ?? existing.name ?? describeCondition(existing),
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
  } else if (overrides.value !== undefined) {
    const value = Number(overrides.value);
    if (!Number.isFinite(value)) throw new UsageError('--value must be a number.');
    params.rhs_constant = value;
  } else {
    params.rhs_constant = existing.rhs_constant;
  }

  if (existing.basket) {
    params.basket = existing.basket as unknown as AlertBasket;
  }
  if (overrides.status) params.status = overrides.status;

  return params;
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

async function enableAlert(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  await setAlertStatus(ctx, command.args[0], 'enabled');
}

async function disableAlert(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  await setAlertStatus(ctx, command.args[0], 'disabled');
}

/**
 * Kite's alerts API documents no `status` parameter on modify and no
 * dedicated enable/disable endpoint — `status` only ever appears as a
 * response field (neither official SDK implements the alerts API at all, so
 * there's no reference implementation to check either). We send it as an
 * optimistic field on the PUT anyway, since real behaviour can lag docs, but
 * never just trust the request "succeeded": a fresh GET after the PUT is
 * checked, and a mismatch fails loudly rather than reporting an alert as
 * disabled while it is still fully live. The PUT's own response is NOT used
 * for that check — an undocumented field could be echoed straight back from
 * the request body without ever being persisted, which would make the PUT
 * response lie exactly the way this check exists to catch. That distinction
 * matters most for `ato` alerts, which place a real order when they fire — a
 * silently-ignored disable there would be a false sense of safety, not a
 * cosmetic bug.
 */
async function setAlertStatus(
  ctx: Context,
  uuidArg: string | undefined,
  status: 'enabled' | 'disabled',
): Promise<void> {
  ctx.requireSession();
  const uuid = requireUuid(uuidArg);
  const existing = await ctx.api.getAlert(uuid, ctx.signal);

  if (existing.status === 'deleted') {
    throw new UsageError(`Alert ${uuid} has been deleted and cannot be ${status}.`);
  }

  if (existing.status === status) {
    if (ctx.io.json) {
      ctx.io.writeJson(existing);
      return;
    }
    ctx.io.success(`Alert ${existing.name ?? uuid} is already ${status}.`);
    return;
  }

  const params = alertParamsFromExisting(existing, { status });

  await confirmAction(ctx, {
    action: `${status === 'enabled' ? 'Enable' : 'Disable'} alert ${existing.name ?? uuid}`,
    // Re-enabling an ato alert restores its ability to place a real order when
    // it fires, and disabling one is a change to that same order-triggering
    // config — gate both behind the trading guard rails, as for `modify`.
    //
    // Deliberately no `increasesExposure`/`notionalValue` here: the basket was
    // already priced and value-capped at `create` time. Re-checking it against
    // today's cap on `enable` would mean re-quoting every leg (the same work
    // `buildAtoBasket` does at creation) just to toggle a status flag — real
    // scope, not a one-line addition. The gap this leaves: if `maxOrderValue`
    // was tightened after the alert was created, `enable` can still re-arm a
    // basket that now exceeds it. Left as a known limitation rather than
    // silently "fixed" with an unpriced check.
    mutatesOrders: params.type === 'ato',
    details: [
      { label: 'UUID', value: uuid },
      { label: 'Condition', value: describeCondition(existing) },
      {
        label: 'Status',
        value: `${colourAlertStatus(ctx.io, existing.status)} → ${colourAlertStatus(ctx.io, status)}`,
      },
    ],
  });

  if (ctx.options.dryRun) return;

  await ctx.api.modifyAlert(uuid, params, ctx.signal);

  // Verify against a FRESH read, not the PUT response: an undocumented field
  // could just be echoed back from the request body without ever being
  // persisted, which would make the PUT response say "disabled" for an alert
  // Kite never actually touched. A re-GET reflects what was actually stored —
  // its only failure mode is read-after-write lag, which errs toward a
  // spurious failure here, never a false "disabled" on a still-live alert.
  const verified = await ctx.api.getAlert(uuid, ctx.signal);

  if (verified.status !== status) {
    throw new KiteCliError(
      `Kite accepted the request, but alert ${uuid} is still "${verified.status}", not "${status}".`,
      ExitCode.Failure,
      "Kite's alerts API does not document a way to toggle status, so this may not be supported. " +
        (params.type === 'ato'
          ? 'Delete and recreate the alert instead.'
          : '`kite alerts delete` removes it outright.'),
    );
  }

  if (ctx.io.json) {
    ctx.io.writeJson(verified);
    return;
  }
  ctx.io.success(`Alert ${verified.name ?? uuid} ${status}.`);
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

  // Deleting an `ato` alert cancels a live order-arming trigger — the same
  // kill-switch gate `enable`/`disable` and `orders cancel`/`gtt delete` apply
  // to their own unwind actions, despite all of them reducing risk rather than
  // increasing it. A `simple` alert moves no money and stays ungated, matching
  // `create`/`modify`/`enable`/`disable`. An alert we could not verify is
  // treated as though it might be `ato` — fail closed, not "assume simple".
  const mayBeAto = uuids.some((uuid) => known.get(uuid)?.type === 'ato' || !known.has(uuid));

  await confirmAction(ctx, {
    action: uuids.length === 1 ? `Delete alert ${uuids[0]}` : `Delete ${uuids.length} alerts`,
    mutatesOrders: mayBeAto,
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

/** Commander reducer for a repeatable option: accumulate values into an array. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** A finite number literal — rejects '', 'NaN', '1e', '2900abc', etc. */
function isNumeric(value: string): boolean {
  return value !== '' && Number.isFinite(Number(value));
}

function parsePositive(value: string, label: string, spec: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--order "${spec}" has an invalid ${label} "${value}"; expected a positive number.`);
  }
  return n;
}

function renderTableFor<T>(ctx: Context, rows: readonly T[], columns: Array<Column<T>>): string {
  return renderTable(ctx.io, rows, columns, {
    compact: ctx.config.output.compact,
  });
}
