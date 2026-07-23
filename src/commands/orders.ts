import { z } from 'zod';
import type { Context } from '../context.js';
import {
  ORDER_TYPES,
  type OrderType,
  type PlaceOrderParams,
  PRODUCTS,
  type Product,
  type TransactionType,
  VALIDITIES,
  VARIETIES,
  type Validity,
  type Variety,
} from '../core/api.js';
import { ExitCode, KiteApiError, KiteCliError, NetworkError, UsageError } from '../core/errors.js';
import { formatInstrumentKey, parseInstrumentKey } from '../core/instruments.js';
import { type Order, TERMINAL_ORDER_STATUSES, type Trade } from '../core/schemas.js';
import { dateTime, money, quantity, rupees, timeOnly } from '../output/format.js';
import { type Column, heading, printTable, renderKeyValue, renderTable } from '../output/table.js';
import { assertTradingEnabled, buildOrderTag, CLI_TAG_PREFIX, confirmAction } from '../safety.js';
import type { CommandFactory } from './types.js';

export const orderCommands: CommandFactory = (program, run) => {
  const orders = program.command('orders').description('View and manage orders');

  orders
    .command('list', { isDefault: true })
    .description("Show today's orderbook")
    .option('--open', 'Show only orders that are still working')
    .action(run(listOrders));

  orders
    .command('get')
    .description('Show the full state history of one order')
    .argument('<order-id>')
    .action(run(getOrder));

  orders
    .command('reconcile')
    .description('Check whether a tagged order reached Kite (recovery after an ambiguous failure)')
    .argument('[tag]', 'Order tag to look up; omit to list the orders this CLI placed today')
    .action(run(reconcileOrders));

  orders
    .command('place')
    .description('Place an order')
    .argument('<instrument>', 'Instrument as EXCHANGE:SYMBOL, e.g. NSE:INFY')
    .requiredOption('-s, --side <side>', 'BUY or SELL')
    .requiredOption('-q, --quantity <n>', 'Quantity')
    .option('-t, --type <type>', `Order type (${ORDER_TYPES.join(', ')})`, 'MARKET')
    .option('-p, --price <price>', 'Limit price (required for LIMIT and SL)')
    .option('--trigger-price <price>', 'Trigger price (required for SL and SL-M)')
    .option('--product <product>', `Product (${PRODUCTS.join(', ')})`, 'CNC')
    .option('--variety <variety>', `Variety (${VARIETIES.join(', ')})`, 'regular')
    .option('--validity <validity>', `Validity (${VALIDITIES.join(', ')})`, 'DAY')
    .option('--validity-ttl <minutes>', 'Minutes to live, for TTL validity')
    .option('--disclosed-quantity <n>', 'Disclosed quantity')
    .option('--iceberg-legs <n>', 'Number of iceberg legs (2-50)')
    .option('--iceberg-quantity <n>', 'Quantity per iceberg leg')
    .option('--tag <tag>', 'Custom tag, max 20 alphanumeric characters')
    .action(run(placeOrder));

  orders
    .command('modify')
    .description('Modify a pending order')
    .argument('<order-id>')
    .option('-q, --quantity <n>', 'New quantity')
    .option('-p, --price <price>', 'New limit price')
    .option('--trigger-price <price>', 'New trigger price')
    .option('-t, --type <type>', `New order type (${ORDER_TYPES.join(', ')})`)
    .option('--validity <validity>', `New validity (${VALIDITIES.join(', ')})`)
    .option('--variety <variety>', 'Order variety (inferred from the orderbook if omitted)')
    .action(run(modifyOrder));

  orders
    .command('cancel')
    .description('Cancel a pending order')
    .argument('<order-id>')
    .option('--variety <variety>', 'Order variety (inferred from the orderbook if omitted)')
    .action(run(cancelOrder));

  program.command('trades').description("Show today's executed trades").action(run(listTrades));
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function listOrders(ctx: Context, opts: { open?: boolean }): Promise<void> {
  ctx.requireSession();
  const all = await ctx.api.getOrders(ctx.signal);
  const rows = opts.open ? all.filter((order) => !TERMINAL_ORDER_STATUSES.has(order.status)) : all;

  printTable(ctx.io, rows, orderColumns(), rows, {
    compact: ctx.config.output.compact,
    empty: opts.open ? 'No working orders.' : 'No orders today.',
  });
}

function orderColumns(): Array<Column<Order>> {
  return [
    { header: 'Time', value: (o) => timeOnly(o.order_timestamp) },
    { header: 'Order ID', value: (o, io) => io.dim(o.order_id) },
    { header: 'Symbol', value: (o, io) => io.bold(o.tradingsymbol ?? '—') },
    {
      header: 'Side',
      value: (o, io) =>
        o.transaction_type === 'BUY' ? io.green('BUY') : o.transaction_type === 'SELL' ? io.red('SELL') : '—',
    },
    { header: 'Type', value: (o) => o.order_type ?? '—' },
    { header: 'Product', value: (o) => o.product ?? '—' },
    {
      header: 'Qty',
      value: (o) => `${quantity(o.filled_quantity ?? 0)}/${quantity(o.quantity ?? 0)}`,
      align: 'right',
    },
    {
      header: 'Price',
      value: (o) => money(o.average_price || o.price),
      align: 'right',
    },
    { header: 'Status', value: (o, io) => colourStatus(io, o.status) },
  ];
}

function colourStatus(io: Context['io'], status: string): string {
  switch (status) {
    case 'COMPLETE':
      return io.green(status);
    case 'REJECTED':
      return io.red(status);
    case 'CANCELLED':
      return io.dim(status);
    case 'OPEN':
    case 'TRIGGER PENDING':
      return io.yellow(status);
    default:
      return status;
  }
}

async function getOrder(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const orderId = command.args[0];
  if (!orderId) throw new UsageError('An order ID is required.');

  const history = await ctx.api.getOrderHistory(orderId, ctx.signal);
  if (history.length === 0) {
    throw new KiteCliError(`No order found with ID ${orderId}.`, ExitCode.Input);
  }

  if (ctx.io.json) {
    ctx.io.writeJson(history);
    return;
  }

  const latest = history[history.length - 1]!;
  const { io } = ctx;

  io.line(heading(io, `Order ${orderId}`));
  io.line(
    renderKeyValue(io, [
      ['Symbol', `${latest.exchange ?? ''}:${latest.tradingsymbol ?? '—'}`],
      ['Side', latest.transaction_type ?? '—'],
      ['Type', `${latest.order_type ?? '—'} / ${latest.product ?? '—'} / ${latest.variety ?? '—'}`],
      ['Quantity', `${quantity(latest.filled_quantity ?? 0)} filled of ${quantity(latest.quantity ?? 0)}`],
      ['Price', money(latest.price)],
      ['Average price', money(latest.average_price)],
      ['Trigger price', latest.trigger_price ? money(latest.trigger_price) : '—'],
      ['Status', colourStatus(io, latest.status)],
      ['Message', latest.status_message ?? '—'],
      ['Tag', latest.tag ?? '—'],
      ['Placed', dateTime(latest.order_timestamp)],
    ]),
  );

  io.line(heading(io, 'State history'));
  io.line(
    renderTableFor(ctx, history, [
      { header: 'Time', value: (o) => timeOnly(o.order_timestamp) },
      { header: 'Status', value: (o, io) => colourStatus(io, o.status) },
      {
        header: 'Filled',
        value: (o) => quantity(o.filled_quantity ?? 0),
        align: 'right',
      },
      {
        header: 'Pending',
        value: (o) => quantity(o.pending_quantity ?? 0),
        align: 'right',
      },
      { header: 'Message', value: (o) => o.status_message ?? '' },
    ]),
  );

  const trades = await ctx.api.getOrderTrades(orderId, ctx.signal);
  if (trades.length > 0) {
    io.line(heading(io, 'Fills'));
    io.line(renderTableFor(ctx, trades, tradeColumns()));
  }
}

async function listTrades(ctx: Context): Promise<void> {
  ctx.requireSession();
  const trades = await ctx.api.getTrades(ctx.signal);
  printTable(ctx.io, trades, tradeColumns(), trades, {
    compact: ctx.config.output.compact,
    empty: 'No trades today.',
  });
}

function tradeColumns(): Array<Column<Trade>> {
  return [
    {
      header: 'Time',
      value: (t) => timeOnly(t.fill_timestamp ?? t.exchange_timestamp),
    },
    { header: 'Trade ID', value: (t, io) => io.dim(t.trade_id) },
    { header: 'Symbol', value: (t, io) => io.bold(t.tradingsymbol ?? '—') },
    {
      header: 'Side',
      value: (t, io) => (t.transaction_type === 'BUY' ? io.green('BUY') : io.red('SELL')),
    },
    { header: 'Qty', value: (t) => quantity(t.quantity), align: 'right' },
    { header: 'Price', value: (t) => money(t.average_price), align: 'right' },
    {
      header: 'Value',
      value: (t) => money((t.average_price ?? 0) * (t.quantity ?? 0)),
      align: 'right',
    },
  ];
}

// ---------------------------------------------------------------------------
// Place
// ---------------------------------------------------------------------------

/**
 * Commander types `.opts<T>()` as a cast rather than inferring from the
 * `.option()` declarations, so nothing checks that this shape matches what was
 * registered. Re-validating here turns that silent type lie into a runtime
 * guarantee — worth it on the one command that spends money.
 */
const PlaceOptionsSchema = z.object({
  side: z.string(),
  quantity: z.coerce.number().int().positive(),
  type: z.string().default('MARKET'),
  price: z.coerce.number().positive().optional(),
  triggerPrice: z.coerce.number().positive().optional(),
  product: z.string().default('CNC'),
  variety: z.string().default('regular'),
  validity: z.string().default('DAY'),
  validityTtl: z.coerce.number().int().positive().optional(),
  disclosedQuantity: z.coerce.number().int().nonnegative().optional(),
  icebergLegs: z.coerce.number().int().min(2).max(50).optional(),
  icebergQuantity: z.coerce.number().int().positive().optional(),
  tag: z
    .string()
    .max(20)
    .regex(/^[a-zA-Z0-9]*$/, 'Tag must be alphanumeric.')
    .optional(),
});

async function placeOrder(ctx: Context, rawOpts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  assertTradingEnabled(ctx);

  const parsed = PlaceOptionsSchema.safeParse(rawOpts);
  if (!parsed.success) {
    throw new UsageError(`Invalid options:\n${z.prettifyError(parsed.error)}`);
  }
  const opts = parsed.data;

  const instrumentArg = command.args[0];
  if (!instrumentArg) throw new UsageError('An instrument is required, e.g. `kite orders place NSE:INFY ...`.');
  const instrument = parseInstrumentKey(instrumentArg);
  const instrumentKey = formatInstrumentKey(instrument.exchange, instrument.tradingsymbol);

  const side = opts.side.toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new UsageError('--side must be BUY or SELL.');

  const orderType = normalise(opts.type, ORDER_TYPES, 'order type') as OrderType;
  const product = normalise(opts.product, PRODUCTS, 'product') as Product;
  const validity = normalise(opts.validity, VALIDITIES, 'validity') as Validity;
  const variety = normalise(opts.variety, VARIETIES, 'variety', false) as Variety;

  // --- input coherence ----------------------------------------------------
  if ((orderType === 'LIMIT' || orderType === 'SL') && opts.price === undefined) {
    throw new UsageError(`--price is required for a ${orderType} order.`);
  }
  if ((orderType === 'SL' || orderType === 'SL-M') && opts.triggerPrice === undefined) {
    throw new UsageError(`--trigger-price is required for a ${orderType} order.`);
  }
  if (orderType === 'MARKET' && opts.price !== undefined) {
    throw new UsageError('--price cannot be used with a MARKET order.');
  }
  if (validity === 'TTL' && opts.validityTtl === undefined) {
    throw new UsageError('--validity-ttl is required when validity is TTL.');
  }
  if (variety === 'iceberg' && (opts.icebergLegs === undefined || opts.icebergQuantity === undefined)) {
    throw new UsageError('--iceberg-legs and --iceberg-quantity are required for an iceberg order.');
  }

  // --- resolve the instrument so the preview shows what will really trade ---
  await ctx.instruments.load({ signal: ctx.signal }).catch(() => {
    // A stale or missing instrument cache must not block order placement; we
    // simply lose the enrichment below.
  });
  const resolved = ctx.instruments.lookupKey(instrumentKey);

  // --- estimate notional value for the cap and confirmation escalation ------
  // An unknown value is NOT treated as "safe": assertWithinValueCap refuses
  // when a cap is configured, and the confirmation escalates to a typed
  // challenge. So a failed quote lookup costs friction, never protection.
  let referencePrice = opts.price;
  let priceLookupFailed = false;
  if (referencePrice === undefined) {
    try {
      const ltp = await ctx.api.getLtp([instrumentKey], ctx.signal);
      referencePrice = ltp[instrumentKey]?.last_price;
      if (referencePrice === undefined) priceLookupFailed = true;
    } catch {
      // The quote endpoint is capped at 1 req/sec, so a 429 here is routine.
      priceLookupFailed = true;
    }
  }
  if (priceLookupFailed) {
    ctx.io.warn(`Could not fetch a price for ${instrumentKey}; this order's value cannot be estimated.`);
  }
  const notionalValue = referencePrice !== undefined ? referencePrice * opts.quantity : undefined;

  // A unique tag is ALWAYS set, even when the user supplied one. Kite has no
  // idempotency key, so this is the only way to tell "the request failed" from
  // "the request succeeded but the response was lost" — and a non-unique tag
  // would make that check report the wrong order.
  const tag = buildOrderTag(opts.tag);

  await confirmAction(ctx, {
    action: `Place ${side} order for ${opts.quantity} ${instrument.tradingsymbol}`,
    mutatesOrders: true,
    increasesExposure: true,
    notionalValue,
    challengeToken: instrument.tradingsymbol,
    details: [
      { label: 'Instrument', value: instrumentKey },
      ...(resolved
        ? [
            {
              label: 'Resolved',
              value: `${resolved.name ?? resolved.tradingsymbol} (token ${resolved.instrument_token})`,
            },
            ...(resolved.lot_size && resolved.lot_size > 1
              ? [
                  {
                    label: 'Lot size',
                    value: `${resolved.lot_size} (${opts.quantity / resolved.lot_size} lots)`,
                  },
                ]
              : []),
          ]
        : [
            {
              label: 'Resolved',
              value: ctx.io.yellow('not in the local instrument cache'),
            },
          ]),
      {
        label: 'Side',
        value: side === 'BUY' ? ctx.io.green(side) : ctx.io.red(side),
      },
      { label: 'Quantity', value: quantity(opts.quantity) },
      { label: 'Order type', value: orderType },
      ...(opts.price !== undefined ? [{ label: 'Price', value: rupees(opts.price) }] : []),
      ...(opts.triggerPrice !== undefined ? [{ label: 'Trigger', value: rupees(opts.triggerPrice) }] : []),
      { label: 'Product', value: product },
      { label: 'Variety', value: variety },
      { label: 'Validity', value: validity },
      {
        label: 'Est. value',
        value: notionalValue !== undefined ? rupees(notionalValue) : ctx.io.dim('unknown (no quote available)'),
      },
      { label: 'Tag', value: tag },
    ],
  });

  if (ctx.options.dryRun) return;

  const params: PlaceOrderParams = {
    variety,
    tradingsymbol: instrument.tradingsymbol,
    exchange: instrument.exchange,
    transaction_type: side as TransactionType,
    order_type: orderType,
    quantity: opts.quantity,
    product,
    validity,
    price: opts.price,
    trigger_price: opts.triggerPrice,
    disclosed_quantity: opts.disclosedQuantity,
    validity_ttl: opts.validityTtl,
    iceberg_legs: opts.icebergLegs,
    iceberg_quantity: opts.icebergQuantity,
    tag,
  };

  // Heads-up as this process approaches Kite's order caps; the limiter refuses
  // outright once a cap is actually reached.
  if (ctx.client.limiter.nearOrderLimit()) {
    const usage = ctx.client.limiter.orderUsage();
    ctx.io.warn(`Approaching Kite's order caps this session (${usage.minute}/min, ${usage.day}/day).`);
  }

  let result: Awaited<ReturnType<typeof ctx.api.placeOrder>>;
  try {
    result = await ctx.api.placeOrder(params, ctx.signal);
  } catch (err) {
    // THE critical path. An ambiguous failure means the order may have reached
    // the OMS and executed. Retrying blindly is how a CLI buys twice, so we
    // reconcile against the tag we chose instead.
    if (isAmbiguousFailure(err)) {
      await reconcileAfterFailure(ctx, tag, err as Error);
      return;
    }
    throw err;
  }

  // With autoslice the response is an array with mixed successes and errors.
  const orderIds: string[] = [];
  const errors: string[] = [];
  if (Array.isArray(result)) {
    for (const entry of result) {
      // Loose schemas widen these to `unknown`, and a sliced response mixes
      // successes with errors, so check the shape rather than trusting it.
      const orderId = (entry as { order_id?: unknown }).order_id;
      if (typeof orderId === 'string') {
        orderIds.push(orderId);
      } else {
        const message = (entry as { error?: { message?: unknown } }).error?.message;
        errors.push(typeof message === 'string' ? message : 'Unknown slice error');
      }
    }
  } else {
    orderIds.push(result.order_id);
  }

  // Set before any early return: a sliced order can partially fail, and a
  // script reading only the exit code must not see success.
  if (errors.length > 0) process.exitCode = ExitCode.Order;

  if (ctx.io.json) {
    ctx.io.writeJson({ order_ids: orderIds, errors, tag });
    return;
  }

  for (const orderId of orderIds) {
    ctx.io.success(`Order placed: ${ctx.io.bold(orderId)}`);
  }
  for (const error of errors) {
    ctx.io.error(`Slice failed: ${error}`);
  }
  if (orderIds.length > 0) {
    // Acceptance by the OMS is not execution — the docs are explicit about this.
    ctx.io.info(
      `Accepted by the OMS. That is not the same as executed — check with \`kite orders get ${orderIds[0]}\`.`,
    );
  }
}

/**
 * Did this failure leave us unsure whether the order was executed?
 *
 * A socket error is the obvious case, but a 5xx is equally ambiguous: Kite's
 * gateway can fail *after* the OMS accepted the order. Treating those as clean
 * failures would send the user to `hintForApiError`'s "retry shortly" advice
 * and buy twice. A 4xx is unambiguous — the request was rejected before it
 * could execute — so those propagate normally.
 */
function isAmbiguousFailure(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (err instanceof KiteApiError) {
    // 429 is included: Kite may have rate-limited the response, not the order.
    return err.status >= 500 || err.status === 429;
  }
  return false;
}

/**
 * Recover from an ambiguous order placement failure.
 *
 * Zerodha's own guidance: do NOT retry a failed POST /orders. Fetch the
 * orderbook and look for the tag; only place again if it is absent.
 */
async function reconcileAfterFailure(ctx: Context, tag: string, cause: Error): Promise<void> {
  const { io } = ctx;
  io.warn(`The order request failed: ${cause.message}`);
  io.info('Checking whether it reached Kite anyway…');

  try {
    const matches = await ctx.api.findOrderByTag(tag, ctx.signal);
    if (matches.length > 0) {
      const order = matches[0]!;
      if (io.json) {
        ctx.io.writeJson({
          order_ids: matches.map((o) => o.order_id),
          tag,
          reconciled: true,
        });
        return;
      }
      io.warn(`The order DID reach Kite: ${io.bold(order.order_id)} (${order.status}).`);
      io.info('It was not placed twice. Do not re-run this command.');
      process.exitCode = ExitCode.Upstream;
      return;
    }

    if (io.json) {
      ctx.io.writeJson({ order_ids: [], tag, reconciled: true, placed: false });
      process.exitCode = ExitCode.Upstream;
      return;
    }
    io.warn(`No order was found for tag ${tag}. It looks like the order did not reach Kite.`);
    io.info(`Verify with \`kite orders list\` before retrying, in case it simply has not appeared yet.`);
    process.exitCode = ExitCode.Upstream;
  } catch {
    // Reconciliation itself failed — the worst case. Be explicit that we do
    // not know, rather than guessing.
    io.error('Could not reach Kite to check whether the order was placed.');
    io.error(`Check your orderbook manually for tag ${io.bold(tag)} BEFORE retrying.`);
    process.exitCode = ExitCode.Upstream;
  }
}

/**
 * Standalone, after-the-fact reconciliation for the no-idempotency problem.
 *
 * `orders place` reconciles automatically the instant a placement fails (see
 * {@link reconcileAfterFailure}), but that check lives and dies with the
 * process — a killed shell, a crashed script, a slept laptop and it is gone.
 * This re-runs it on demand. Given the unique tag every order carries, it
 * answers the only question that matters after an ambiguous failure — "did it
 * actually reach Kite?" — so you know whether it is safe to place again.
 *
 * With a tag, it looks that tag up. With none, it lists the orders this CLI
 * placed today (those carrying the {@link CLI_TAG_PREFIX} prefix), so you can
 * still find one whose exact tag you did not capture. It is a query, not a
 * mutation: it exits 0 on any clean answer, and the `--json` `placed` flag is
 * the machine-readable verdict.
 */
async function reconcileOrders(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  const { io } = ctx;
  const tag = command.args[0];

  if (tag) {
    const matches = await ctx.api.findOrderByTag(tag, ctx.signal);
    if (io.json) {
      io.writeJson({ tag, placed: matches.length > 0, order_ids: matches.map((o) => o.order_id), orders: matches });
      return;
    }
    if (matches.length === 0) {
      io.warn(`No order found for tag ${io.bold(tag)}.`);
      io.info(
        'If a placement looked like it failed, it most likely did not reach Kite — but check `kite orders list` before retrying, in case it simply has not appeared yet.',
      );
      return;
    }
    io.success(`Found ${matches.length === 1 ? 'an order' : `${matches.length} orders`} for tag ${io.bold(tag)}:`);
    io.line(renderTableFor(ctx, matches, reconcileColumns()));
    io.info('If placing this order looked like it failed, it went through — do not place it again.');
    return;
  }

  const mine = (await ctx.api.getOrders(ctx.signal)).filter(hasCliTag);
  printTable(io, mine, reconcileColumns(), mine, {
    compact: ctx.config.output.compact,
    empty: `No orders tagged by this CLI today (looking for the \`${CLI_TAG_PREFIX}\` prefix).`,
  });
  if (mine.length > 0 && !io.json) {
    io.info('Reconcile a specific one with `kite orders reconcile <tag>`.');
  }
}

/** True if this order carries a CLI-generated tag (see {@link CLI_TAG_PREFIX}). */
function hasCliTag(order: Order): boolean {
  if (order.tag?.startsWith(CLI_TAG_PREFIX)) return true;
  return order.tags?.some((t) => t.startsWith(CLI_TAG_PREFIX)) ?? false;
}

function reconcileColumns(): Array<Column<Order>> {
  return [
    { header: 'Time', value: (o) => timeOnly(o.order_timestamp) },
    { header: 'Order ID', value: (o, io) => io.dim(o.order_id) },
    { header: 'Symbol', value: (o, io) => io.bold(o.tradingsymbol ?? '—') },
    {
      header: 'Side',
      value: (o, io) =>
        o.transaction_type === 'BUY' ? io.green('BUY') : o.transaction_type === 'SELL' ? io.red('SELL') : '—',
    },
    {
      header: 'Qty',
      value: (o) => `${quantity(o.filled_quantity ?? 0)}/${quantity(o.quantity ?? 0)}`,
      align: 'right',
    },
    { header: 'Status', value: (o, io) => colourStatus(io, o.status) },
    { header: 'Tag', value: (o) => o.tag ?? '—' },
  ];
}

// ---------------------------------------------------------------------------
// Modify / cancel
// ---------------------------------------------------------------------------

async function modifyOrder(
  ctx: Context,
  opts: {
    quantity?: string;
    price?: string;
    triggerPrice?: string;
    type?: string;
    validity?: string;
    variety?: string;
  },
  command: { args: string[] },
): Promise<void> {
  ctx.requireSession();
  assertTradingEnabled(ctx);

  const orderId = command.args[0];
  if (!orderId) throw new UsageError('An order ID is required.');

  const lookup = await findOrder(ctx, orderId);
  const variety = resolveVariety(lookup, opts.variety, orderId, 'Modifying');
  const existing = lookup.status === 'found' ? lookup.order : undefined;

  const changes: Array<{ label: string; value: string }> = [];
  const params: Parameters<typeof ctx.api.modifyOrder>[0] = {
    variety,
    order_id: orderId,
  };

  if (opts.quantity !== undefined) {
    params.quantity = requirePositiveInt(opts.quantity, '--quantity');
    changes.push({
      label: 'Quantity',
      value: `${quantity(existing?.quantity)} → ${quantity(params.quantity)}`,
    });
  }
  if (opts.price !== undefined) {
    params.price = requirePositiveNumber(opts.price, '--price');
    changes.push({
      label: 'Price',
      value: `${money(existing?.price)} → ${money(params.price)}`,
    });
  }
  if (opts.triggerPrice !== undefined) {
    params.trigger_price = requirePositiveNumber(opts.triggerPrice, '--trigger-price');
    changes.push({
      label: 'Trigger',
      value: `${money(existing?.trigger_price)} → ${money(params.trigger_price)}`,
    });
  }
  if (opts.type !== undefined) {
    params.order_type = normalise(opts.type, ORDER_TYPES, 'order type') as OrderType;
    changes.push({
      label: 'Order type',
      value: `${existing?.order_type ?? '—'} → ${params.order_type}`,
    });
  }
  if (opts.validity !== undefined) {
    params.validity = normalise(opts.validity, VALIDITIES, 'validity') as Validity;
    changes.push({
      label: 'Validity',
      value: `${existing?.validity ?? '—'} → ${params.validity}`,
    });
  }

  if (changes.length === 0) {
    throw new UsageError(
      'Nothing to modify. Pass at least one of --quantity, --price, --trigger-price, --type or --validity.',
    );
  }

  // Price the modified order for the cap and escalation checks.
  //
  // Falling back to `?? 0` would silently produce a notional of 0 for any
  // order with no limit price (MARKET, SL-M) — and a 0 reads as "small", which
  // is exactly backwards. Resolve a real reference price, falling back to the
  // last traded price, and leave it UNDEFINED if we genuinely cannot tell so
  // the safety layer fails closed.
  const effectiveQuantity = params.quantity ?? existing?.quantity;
  let effectivePrice = params.price ?? (existing?.price || undefined);

  if (effectivePrice === undefined && existing?.tradingsymbol && existing.exchange) {
    const key = formatInstrumentKey(existing.exchange, existing.tradingsymbol);
    try {
      const ltp = await ctx.api.getLtp([key], ctx.signal);
      effectivePrice = ltp[key]?.last_price;
    } catch {
      // Leave undefined — confirmAction escalates rather than waving it through.
    }
  }

  const notionalValue =
    effectiveQuantity !== undefined && effectivePrice !== undefined && effectivePrice > 0
      ? effectiveQuantity * effectivePrice
      : undefined;

  // Only a modify that actually RAISES exposure — a bigger quantity, a higher
  // limit price, or a switch to a less-bounded order type — should be subject to
  // the value cap. Lowering the quantity or the price reduces exposure, and
  // blocking that because the cap could not be priced would be the same safety
  // inversion as blocking a cancel. When the existing order is unknown we cannot
  // prove it is a reduction, so we fail closed and treat it as increasing.
  const raisesQuantity =
    params.quantity !== undefined && (existing?.quantity === undefined || params.quantity > existing.quantity);
  const raisesPrice = params.price !== undefined && (existing?.price === undefined || params.price > existing.price);
  const loosensType = params.order_type === 'MARKET' || params.order_type === 'SL-M';
  const increasesExposure = raisesQuantity || raisesPrice || loosensType;

  await confirmAction(ctx, {
    action: `Modify order ${orderId}`,
    mutatesOrders: true,
    increasesExposure,
    notionalValue,
    challengeToken: existing?.tradingsymbol,
    details: [
      { label: 'Order ID', value: orderId },
      {
        label: 'Symbol',
        value: existing ? `${existing.exchange}:${existing.tradingsymbol}` : 'unknown',
      },
      { label: 'Status', value: existing?.status ?? 'unknown' },
      { label: 'Variety', value: variety },
      ...changes,
    ],
  });

  if (ctx.options.dryRun) return;

  const result = await ctx.api.modifyOrder(params, ctx.signal);

  if (ctx.io.json) {
    ctx.io.writeJson(result);
    return;
  }
  ctx.io.success(`Order ${result.order_id} modified.`);
  // Kite hard-caps modifications; past 25 you must cancel and re-place.
  ctx.io.info('Kite allows at most 25 modifications per order.');
}

async function cancelOrder(ctx: Context, opts: { variety?: string }, command: { args: string[] }): Promise<void> {
  ctx.requireSession();
  assertTradingEnabled(ctx);

  const orderId = command.args[0];
  if (!orderId) throw new UsageError('An order ID is required.');

  const lookup = await findOrder(ctx, orderId);
  const variety = resolveVariety(lookup, opts.variety, orderId, 'Cancelling');
  const existing = lookup.status === 'found' ? lookup.order : undefined;

  if (existing && TERMINAL_ORDER_STATUSES.has(existing.status)) {
    throw new KiteCliError(`Order ${orderId} is already ${existing.status} and cannot be cancelled.`, ExitCode.Input);
  }

  await confirmAction(ctx, {
    action: `Cancel order ${orderId}`,
    mutatesOrders: true,
    details: [
      { label: 'Order ID', value: orderId },
      {
        label: 'Symbol',
        value: existing ? `${existing.exchange}:${existing.tradingsymbol}` : 'unknown',
      },
      { label: 'Side', value: existing?.transaction_type ?? 'unknown' },
      { label: 'Quantity', value: quantity(existing?.quantity) },
      { label: 'Status', value: existing?.status ?? 'unknown' },
      { label: 'Variety', value: variety },
    ],
  });

  if (ctx.options.dryRun) return;

  const result = await ctx.api.cancelOrder(
    {
      variety,
      order_id: orderId,
      ...(existing?.parent_order_id ? { parent_order_id: existing.parent_order_id } : {}),
    },
    ctx.signal,
  );

  if (ctx.io.json) {
    ctx.io.writeJson(result);
    return;
  }
  ctx.io.success(`Order ${result.order_id} cancelled.`);
}

// ---------------------------------------------------------------------------

/**
 * Look up an order in today's book so previews show resolved facts.
 *
 * The result distinguishes "not in the book" from "could not read the book".
 * Collapsing both to `undefined` is dangerous: callers would silently fall back
 * to variety 'regular' and skip the terminal-status guard, cancelling a CO or
 * iceberg order at the wrong endpoint after showing the user a preview that
 * read "unknown".
 */
type OrderLookup =
  | { status: 'found'; order: Order }
  | { status: 'not-found' }
  | { status: 'lookup-failed'; error: unknown };

async function findOrder(ctx: Context, orderId: string): Promise<OrderLookup> {
  try {
    const orders = await ctx.api.getOrders(ctx.signal);
    const order = orders.find((candidate) => candidate.order_id === orderId);
    return order ? { status: 'found', order } : { status: 'not-found' };
  } catch (error) {
    return { status: 'lookup-failed', error };
  }
}

/**
 * Resolve the variety for a mutating operation on an existing order.
 *
 * Fails closed when the orderbook could not be read and the user did not say
 * which variety it is — guessing 'regular' would target the wrong endpoint.
 */
function resolveVariety(lookup: OrderLookup, explicit: string | undefined, orderId: string, verb: string): Variety {
  if (explicit) return normalise(explicit, VARIETIES, 'variety', false) as Variety;
  if (lookup.status === 'found') return (lookup.order.variety ?? 'regular') as Variety;

  if (lookup.status === 'lookup-failed') {
    throw new KiteCliError(
      `Could not read the orderbook, so the variety of order ${orderId} is unknown.`,
      ExitCode.Upstream,
      `Retry, or pass --variety explicitly if you know it. ${verb} an order at the wrong variety endpoint fails or targets the wrong order.`,
    );
  }

  throw new KiteCliError(
    `Order ${orderId} is not in today's orderbook.`,
    ExitCode.Input,
    'Check the ID with `kite orders list`.',
  );
}

function normalise(value: string, allowed: readonly string[], label: string, upper = true): string {
  const candidate = upper ? value.toUpperCase() : value.toLowerCase();
  if (allowed.includes(candidate)) return candidate;
  throw new UsageError(`Unknown ${label} "${value}".`, `Valid values: ${allowed.join(', ')}.`);
}

function requirePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive whole number.`);
  return n;
}

function requirePositiveNumber(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number.`);
  return n;
}

function renderTableFor<T>(ctx: Context, rows: readonly T[], columns: Array<Column<T>>): string {
  return renderTable(ctx.io, rows, columns, {
    compact: ctx.config.output.compact,
  });
}
