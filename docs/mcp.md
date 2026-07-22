# MCP server

`kite mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server
over stdio, so an LLM agent — Claude, or any MCP-capable client — can inspect your
Kite account against **live** data: holdings, positions, funds, the orderbook,
quotes, and instrument search. See the README's
[Agents (MCP)](https://github.com/pungoyal/kite-cli#agents-mcp) section for the short
version; this page is the full reference.

## Read-only, by design

The server exposes Kite's **read** endpoints only. It cannot place, modify, or
cancel an order, and there is no flag that turns that on.

That is a deliberate consequence of the [safety model](/safety): a money-moving
command must render the *resolved* order and be confirmed at an interactive
terminal, and an MCP server — launched as a background subprocess by an agent — has
no terminal to confirm at. Rather than weaken that guarantee for the convenience of
an automated caller, writes are simply not on the menu. An agent that decides you
should trade must hand back to a human at a real prompt.

If you want an agent to *draft* an order for you to run yourself, ask it to produce
the `kite orders place …` command — you then review the resolved preview and confirm
it, exactly as you would any other order.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `get_profile` | — | The authenticated Kite user profile |
| `get_holdings` | — | Long-term holdings with average price and P&L |
| `get_positions` | — | Open positions (intraday and overnight) |
| `get_funds` | — | Available margins and cash balance |
| `get_orders` | — | Today's orderbook, including status and fills |
| `get_trades` | — | Today's executed trades |
| `quote` | `instruments: string[]` | Full market quotes |
| `ltp` | `instruments: string[]` | Last traded price |
| `ohlc` | `instruments: string[]` | Open/high/low/close plus last price |
| `search_instruments` | `query`, `exchange?`, `type?`, `limit?` | Matching tradeable instruments |

Instruments are given as `EXCHANGE:TRADINGSYMBOL`, e.g. `NSE:INFY`. Each tool
advertises a JSON Schema for its arguments (derived from the same zod schema that
validates them), so a well-behaved client can construct calls without guessing.

## Setup

Point your MCP client at the `kite` binary with the `mcp` subcommand. For a client
that reads a JSON config (such as Claude Desktop):

```json
{
  "mcpServers": {
    "kite": {
      "command": "kite",
      "args": ["mcp", "--env", "sandbox"]
    }
  }
}
```

**Try the sandbox first.** With `--env sandbox` the agent talks to Zerodha's public
sandbox — fake money, no subscription — so you can see exactly what it reads before
connecting it to your real account. Drop the `"--env", "sandbox"` arguments to run
against production (still read-only):

```json
{
  "mcpServers": {
    "kite": {
      "command": "kite",
      "args": ["mcp"]
    }
  }
}
```

If `kite` isn't on the `PATH` your client sees, use an absolute path (the output of
`which kite`) as `command`.

## Sessions and profiles

The server needs a live session — every tool calls the API. Log in first:

```bash
kite login                 # production
kite login --env sandbox   # sandbox
```

Starting the server without a session exits with code `3` and a message telling you
to log in; it never starts a server whose every call would fail. Sessions expire at
06:00 IST daily (a Kite requirement), so a long-lived agent will start seeing
authentication errors after that until you log in again.

To target a specific [account profile](/configuration), pass it through the args:

```json
{ "command": "kite", "args": ["--profile", "huf", "mcp"] }
```

## Security

The MCP server is held to the same standard as the rest of the transport:

- **stdout carries the protocol alone.** Every human-facing message goes to stderr,
  so nothing can corrupt the JSON-RPC stream the client is parsing.
- **Every result is redacted.** Tool output and error messages pass through the same
  scrubber as the CLI, so a token can never ride out on an MCP response.
- **Calls are paced.** Tools go through the shared [rate limiter](https://github.com/pungoyal/kite-cli/blob/main/src/core/ratelimit.ts),
  so an eager agent is throttled locally rather than tripping Kite's server-side
  limits — quotes in particular are capped at one request per second.
- **No new dependencies.** The stdio transport is newline-delimited JSON-RPC 2.0,
  implemented directly rather than pulling in an SDK, keeping the supply-chain
  surface exactly as small as it was.

The implementation lives in
[`src/core/mcp.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/mcp.ts)
(the protocol) and
[`src/commands/mcp.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/commands/mcp.ts)
(the Kite tools), and `McpServer` is [exported](/api) for library use.
