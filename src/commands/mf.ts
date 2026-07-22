import type { Context } from '../context.js';
import type { MfHolding, MfOrder, MfSip } from '../core/schemas.js';
import { dateTime, money, quantity, rupees, signedRupees } from '../output/format.js';
import { type Column, printTable } from '../output/table.js';
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
  const mf = program.command('mf').description('View mutual fund holdings, orders and SIPs');

  mf.command('holdings', { isDefault: true }).description('Show your mutual fund holdings').action(run(mfHoldings));

  mf.command('orders').description('Show mutual fund orders from the last 7 days').action(run(mfOrders));

  mf.command('sips').description('Show your mutual fund SIPs').action(run(mfSips));
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
