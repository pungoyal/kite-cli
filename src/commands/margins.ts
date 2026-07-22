import type { Context } from '../context.js';
import {
  ORDER_TYPES,
  type OrderType,
  PRODUCTS,
  type Product,
  type TransactionType,
  VARIETIES,
  type Variety,
} from '../core/api.js';
import { UsageError } from '../core/errors.js';
import { formatInstrumentKey, parseInstrumentKey } from '../core/instruments.js';
import type { BasketMargin, OrderMargin } from '../core/schemas.js';
import { money, rupees } from '../output/format.js';
import { type Column, heading, printTable, renderKeyValue } from '../output/table.js';
import type { CommandFactory } from './types.js';

/**
 * Margin and charge calculators — read-only.
 *
 * These POST a hypothetical set of orders to Kite and return what they would
 * cost: `order` gives the per-order required margin (no netting), `basket` the
 * net margin for the set (with spread/hedge benefit), and `charges` the
 * itemised brokerage/tax breakdown (a "virtual contract note"). Nothing is
 * placed, so none of the trading safety layer applies.
 */
export const marginCommands: CommandFactory = (program, run) => {
  const margins = program.command('margins').description('Calculate order margins and charges (nothing is placed)');

  const orderExample =
    'Each order is EXCHANGE:SYMBOL:SIDE:QTY[:TYPE][:PRODUCT][:VARIETY][:PRICE][:trigger=<n>], ' +
    "e.g. 'NFO:NIFTY25AUGFUT:BUY:75:MARKET:NRML'. Product defaults to CNC, variety to regular.";

  margins
    .command('order')
    .description('Required margin for each order on its own')
    .argument('<orders...>', orderExample)
    .action(run(orderMargins));

  margins
    .command('basket')
    .description('Net margin for a basket of orders, with spread/hedge benefit')
    .argument('<orders...>', orderExample)
    .option('--no-consider-positions', 'Ignore existing positions when netting')
    .action(run(basketMargins));

  margins
    .command('charges')
    .description('Itemised charges for a set of executed orders (virtual contract note)')
    .argument('<orders...>', `${orderExample} A non-zero price (the execution price) is required.`)
    .action(run(orderCharges));
};

// ---------------------------------------------------------------------------
// Order-spec parsing
//
// TODO: dedupe with `alerts.ts` parseOrderSpec. The grammars are close but
// diverge (this one carries `variety`, which alerts deliberately rejects, and
// omits validity), and alerts is shipped order-placement code, so this is a
// deliberate second implementation of the same documented grammar rather than
// a risky refactor of the money path.
// ---------------------------------------------------------------------------

/** A hypothetical order, resolved from a spec, ready to serialise per endpoint. */
export interface OrderSpec {
  exchange: string;
  tradingsymbol: string;
  transactionType: TransactionType;
  quantity: number;
  orderType: OrderType;
  product: Product;
  variety: Variety;
  price: number | undefined;
  triggerPrice: number | undefined;
}

/**
 * Parse one `EXCHANGE:SYMBOL:SIDE:QTY[:attrs...]` spec.
 *
 * Attributes after QTY are classified by content — an order type, a product, a
 * variety, a bare number (the price), or `trigger=<n>`. Fails closed: an
 * unrecognised token, a duplicated field, or an empty field rejects the whole
 * spec rather than silently defaulting, since a mis-parsed order yields a
 * silently wrong margin or charge.
 */
export function parseOrderSpec(spec: string): OrderSpec {
  const tokens = spec
    .trim()
    .split(':')
    .map((t) => t.trim());
  if (tokens.length < 4) {
    throw new UsageError(
      `Malformed order "${spec}".`,
      "Expected at least EXCHANGE:SYMBOL:SIDE:QTY, e.g. 'NFO:NIFTY25AUGFUT:BUY:75:NRML'.",
    );
  }

  const [exchangeTok, symbolTok, sideTok, qtyTok, ...rest] = tokens as [string, string, string, string, ...string[]];
  const { exchange, tradingsymbol } = parseInstrumentKey(`${exchangeTok}:${symbolTok}`);

  const side = sideTok.toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') {
    throw new UsageError(`Order side must be BUY or SELL, got "${sideTok}" in "${spec}".`);
  }

  const quantity = Number(qtyTok);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new UsageError(`Order quantity must be a positive integer, got "${qtyTok}" in "${spec}".`);
  }

  let orderType: OrderType | undefined;
  let product: Product | undefined;
  let variety: Variety | undefined;
  let price: number | undefined;
  let triggerPrice: number | undefined;

  const setOnce = <T>(current: T | undefined, next: T, label: string): T => {
    if (current !== undefined) throw new UsageError(`Order "${spec}" sets ${label} more than once.`);
    return next;
  };

  for (const tok of rest) {
    if (tok === '') throw new UsageError(`Order "${spec}" has an empty field. Remove the stray ":".`);

    const eq = tok.indexOf('=');
    if (eq !== -1) {
      const key = tok.slice(0, eq).trim().toLowerCase();
      const value = tok.slice(eq + 1).trim();
      if (key === 'price') price = setOnce(price, parsePositive(value, 'price', spec), 'the price');
      else if (key === 'trigger')
        triggerPrice = setOnce(triggerPrice, parsePositive(value, 'trigger', spec), 'the trigger price');
      else if (key === 'type')
        orderType = setOnce(orderType, normalise(value, ORDER_TYPES, 'order type') as OrderType, 'the order type');
      else if (key === 'product')
        product = setOnce(product, normalise(value, PRODUCTS, 'product') as Product, 'the product');
      else if (key === 'variety')
        variety = setOnce(variety, normalise(value, VARIETIES, 'variety') as Variety, 'the variety');
      else
        throw new UsageError(
          `Order "${spec}" has an unknown field "${key}".`,
          'Valid keys: type, product, variety, price, trigger.',
        );
      continue;
    }

    const upper = tok.toUpperCase();
    const lower = tok.toLowerCase();
    if ((ORDER_TYPES as readonly string[]).includes(upper)) {
      orderType = setOnce(orderType, upper as OrderType, 'the order type');
    } else if ((PRODUCTS as readonly string[]).includes(upper)) {
      product = setOnce(product, upper as Product, 'the product');
    } else if ((VARIETIES as readonly string[]).includes(lower)) {
      variety = setOnce(variety, lower as Variety, 'the variety');
    } else if (isNumeric(tok)) {
      // A bare number is the price. A trigger must be given explicitly.
      price = setOnce(price, parsePositive(tok, 'price', spec), 'the price');
    } else {
      throw new UsageError(
        `Order "${spec}" has an unrecognised field "${tok}".`,
        'Fields after QTY are an order type, product, variety, a price, or trigger=<n>.',
      );
    }
  }

  return {
    exchange,
    tradingsymbol,
    transactionType: side as TransactionType,
    quantity,
    orderType: orderType ?? 'MARKET',
    product: product ?? 'CNC',
    variety: variety ?? 'regular',
    price,
    triggerPrice,
  };
}

function parseSpecs(args: string[]): OrderSpec[] {
  if (args.length === 0) throw new UsageError('At least one order is required.');
  return args.map(parseOrderSpec);
}

/** Serialise for /margins/orders and /margins/basket (price + trigger_price). */
function toMarginOrder(o: OrderSpec) {
  return {
    exchange: o.exchange,
    tradingsymbol: o.tradingsymbol,
    transaction_type: o.transactionType,
    variety: o.variety,
    product: o.product,
    order_type: o.orderType,
    quantity: o.quantity,
    price: o.price ?? 0,
    trigger_price: o.triggerPrice ?? 0,
  };
}

/**
 * Serialise for /charges/orders (average_price + order_id, no price/trigger).
 * Charges are a percentage of quantity × average_price, so a zero price yields
 * a plausible-looking ≈₹0 that is silently wrong — require a real price.
 */
function toChargesOrder(o: OrderSpec, index: number) {
  if (o.price === undefined || o.price <= 0) {
    throw new UsageError(
      `Order "${formatInstrumentKey(o.exchange, o.tradingsymbol)}" needs a non-zero price for charges.`,
      'Charges are computed from quantity × execution price; add a price, e.g. :1500 or price=1500.',
    );
  }
  return {
    // A virtual contract note needs an order_id per leg; the index is fine.
    order_id: String(index + 1),
    exchange: o.exchange,
    tradingsymbol: o.tradingsymbol,
    transaction_type: o.transactionType,
    variety: o.variety,
    product: o.product,
    order_type: o.orderType,
    quantity: o.quantity,
    average_price: o.price,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function orderMargins(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const specs = parseSpecs(command.args);
  const margins = await ctx.api.orderMargins(specs.map(toMarginOrder), ctx.signal);

  const columns = marginColumns();
  printTable(ctx.io, margins, columns, margins, { compact: ctx.config.output.compact, empty: 'No margins returned.' });

  if (ctx.io.json) return;
  const total = margins.reduce((sum, m) => sum + (m.total ?? 0), 0);
  ctx.io.line('');
  ctx.io.line(`  Total margin required ${rupees(total)}`);
}

async function basketMargins(
  ctx: Context,
  opts: { considerPositions?: boolean },
  command: { args: string[] },
): Promise<void> {
  ctx.requireSession();
  const specs = parseSpecs(command.args);
  const basket: BasketMargin = await ctx.api.basketMargins(
    specs.map(toMarginOrder),
    opts.considerPositions !== false,
    ctx.signal,
  );

  if (ctx.io.json) {
    ctx.io.writeJson(basket);
    return;
  }

  const { io } = ctx;
  io.line(heading(io, 'Per order'));
  printTable(io, basket.orders, marginColumns(), basket.orders, {
    compact: ctx.config.output.compact,
    empty: 'No orders.',
  });

  // `final` is the margin actually blocked after spread/hedge benefit; `initial`
  // is the gross figure before it. The difference is the benefit itself.
  const finalTotal = basket.final?.total ?? 0;
  const initialTotal = basket.initial?.total ?? 0;
  io.line('');
  io.line(
    renderKeyValue(io, [
      ['Margin before benefit', rupees(initialTotal)],
      ['Spread/hedge benefit', rupees(Math.max(0, initialTotal - finalTotal))],
      ['Net margin required', io.bold(rupees(finalTotal))],
    ]),
  );
}

async function orderCharges(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const specs = parseSpecs(command.args);
  const charges = await ctx.api.orderCharges(
    specs.map((o, i) => toChargesOrder(o, i)),
    ctx.signal,
  );

  const columns: Array<Column<OrderMargin>> = [
    { header: 'Symbol', value: (m, io) => io.bold(`${m.exchange ?? '?'}:${m.tradingsymbol ?? '?'}`) },
    { header: 'Brokerage', value: (m) => money(m.charges?.brokerage), align: 'right' },
    { header: 'STT/CTT', value: (m) => money(m.charges?.transaction_tax), align: 'right' },
    { header: 'Txn', value: (m) => money(m.charges?.exchange_turnover_charge), align: 'right' },
    { header: 'GST', value: (m) => money(m.charges?.gst?.total), align: 'right' },
    { header: 'Stamp', value: (m) => money(m.charges?.stamp_duty), align: 'right' },
    { header: 'SEBI', value: (m) => money(m.charges?.sebi_turnover_charge), align: 'right' },
    { header: 'Total', value: (m, io) => io.bold(money(m.charges?.total)), align: 'right' },
  ];

  printTable(ctx.io, charges, columns, charges, {
    compact: ctx.config.output.compact,
    empty: 'No charges returned.',
  });

  if (ctx.io.json) return;
  const total = charges.reduce((sum, m) => sum + (m.charges?.total ?? 0), 0);
  ctx.io.line('');
  ctx.io.line(`  Total charges ${rupees(total)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function marginColumns(): Array<Column<OrderMargin>> {
  return [
    { header: 'Symbol', value: (m, io) => io.bold(`${m.exchange ?? '?'}:${m.tradingsymbol ?? '?'}`) },
    { header: 'SPAN', value: (m) => money(m.span), align: 'right' },
    { header: 'Exposure', value: (m) => money(m.exposure), align: 'right' },
    { header: 'Premium', value: (m) => money(m.option_premium), align: 'right' },
    { header: 'Var', value: (m) => money(m.var), align: 'right' },
    { header: 'Total', value: (m, io) => io.bold(money(m.total)), align: 'right' },
  ];
}

function normalise(value: string, allowed: readonly string[], label: string): string {
  const candidate = label === 'variety' ? value.toLowerCase() : value.toUpperCase();
  if ((allowed as readonly string[]).includes(candidate)) return candidate;
  throw new UsageError(`Unknown ${label} "${value}".`, `Valid values: ${allowed.join(', ')}.`);
}

function isNumeric(value: string): boolean {
  return value !== '' && Number.isFinite(Number(value));
}

function parsePositive(value: string, label: string, spec: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`Order "${spec}" has an invalid ${label} "${value}"; expected a positive number.`);
  }
  return n;
}
