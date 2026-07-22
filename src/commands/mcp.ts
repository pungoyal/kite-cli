import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Context } from '../context.js';
import { McpServer, type McpTool } from '../core/mcp.js';
import type { CommandFactory } from './types.js';

/**
 * `kite mcp` — a read-only Model Context Protocol server over stdio.
 *
 * Launched by an MCP client (Claude and others) as a subprocess, it lets an
 * agent inspect a Kite account — holdings, positions, funds, live quotes, the
 * orderbook, instrument search — but never place, modify or cancel an order.
 * The rationale for read-only lives in src/core/mcp.ts.
 *
 * The stdio contract is strict: the JSON-RPC protocol owns stdout, so every
 * human-facing message here goes to stderr (io.info/note already do).
 */

// Single source of truth for the version, like run.ts. package.json sits two
// levels up from both src/commands/ (dev) and dist/commands/ (published).
const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/** Instruments accepted by quote-style tools, e.g. ["NSE:INFY", "NSE:TCS"]. */
const instrumentsArg = z.object({
  instruments: z.array(z.string().min(1)).min(1).describe('Instruments as EXCHANGE:TRADINGSYMBOL, e.g. NSE:INFY'),
});

const searchArg = z.object({
  query: z.string().min(1).describe('Free-text query over trading symbol and name'),
  exchange: z.string().optional().describe('Restrict to an exchange, e.g. NSE, NFO'),
  type: z.string().optional().describe('Restrict to an instrument type, e.g. EQ, CE, PE, FUT'),
  limit: z.number().int().positive().max(100).optional().describe('Maximum results (default 25)'),
});

/** Build one tool, deriving its advertised JSON Schema from the zod schema. */
function tool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<S>, signal?: AbortSignal) => Promise<unknown> | unknown,
): McpTool<S> {
  return {
    name,
    description,
    schema,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    handler,
  };
}

/** The read-only Kite surface exposed to an agent. */
function buildTools(ctx: Context): McpTool[] {
  const { api, instruments, signal } = ctx;
  const noArgs = z.object({});

  return [
    tool('get_profile', 'The authenticated Kite user profile.', noArgs, () => api.getProfile(signal)),
    tool('get_holdings', 'Long-term holdings with average price and P&L.', noArgs, () => api.getHoldings(signal)),
    tool('get_positions', 'Open positions (intraday and overnight).', noArgs, () => api.getPositions(signal)),
    tool('get_funds', 'Available margins and cash balance.', noArgs, () => api.getMargins(signal)),
    tool('get_orders', "Today's orderbook, including status and fills.", noArgs, () => api.getOrders(signal)),
    tool('get_trades', "Today's executed trades.", noArgs, () => api.getTrades(signal)),
    tool('quote', 'Full market quotes for one or more instruments.', instrumentsArg, (a) =>
      api.getQuote(a.instruments, signal),
    ),
    tool('ltp', 'Last traded price for one or more instruments.', instrumentsArg, (a) =>
      api.getLtp(a.instruments, signal),
    ),
    tool('ohlc', 'Open/high/low/close plus last price for one or more instruments.', instrumentsArg, (a) =>
      api.getOhlc(a.instruments, signal),
    ),
    tool('search_instruments', 'Find tradeable instruments by symbol or name.', searchArg, async (a) => {
      await instruments.load({ signal });
      return instruments.search(a.query, {
        exchange: a.exchange,
        type: a.type,
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
      });
    }),
  ];
}

async function mcp(ctx: Context): Promise<void> {
  // A live session is required — every tool hits the API. Fail here (exit 3)
  // rather than starting a server whose every call would 403.
  ctx.requireSession();

  const server = new McpServer({
    name: 'kite-cli',
    version: VERSION,
    tools: buildTools(ctx),
    signal: ctx.signal,
  });

  ctx.io.info('kite MCP server ready on stdio (read-only). Launch this from an MCP client; Ctrl-C to stop.');
  if (ctx.env === 'sandbox') ctx.io.info('Running against the sandbox — no real account.');

  // stdio is the transport: the process's own stdin/stdout carry JSON-RPC.
  await server.serve(process.stdin, process.stdout);
}

export const mcpCommands: CommandFactory = (program, run) => {
  program
    .command('mcp')
    .description('Run a read-only MCP server over stdio for LLM agents (Claude and others)')
    .action(run(mcp));
};
