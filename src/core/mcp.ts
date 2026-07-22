import { createInterface } from 'node:readline';
import type { z } from 'zod';
import { redact, redactString } from './redact.js';

/**
 * A minimal Model Context Protocol (MCP) server over stdio.
 *
 * MCP lets an LLM agent (Claude and others) call tools exposed by a local
 * process. This server exposes Kite's *read* endpoints so an agent can inspect a
 * portfolio, quotes and the orderbook — never place, modify or cancel anything.
 *
 * Two deliberate design choices, both flowing from this repo's own principles:
 *
 *  - **Hand-rolled, not the official SDK.** A minimal dependency tree is a
 *    security property here (see scripts/check-deps.mjs), and the SDK pulls a
 *    heavy transitive closure. The stdio transport is newline-delimited JSON-RPC
 *    2.0 — small enough to implement directly and unit-test in full.
 *  - **Read-only.** A money-moving command must render the resolved order and
 *    obtain confirmation (see src/safety.ts), and an MCP server has no terminal
 *    to confirm at. Rather than weaken that invariant, writes are simply not
 *    exposed. An agent that wants to trade must hand back to a human at a TTY.
 *
 * The transport framing is newline-delimited JSON: one JSON message per line,
 * no embedded newlines, no Content-Length headers (that is the HTTP transport,
 * not stdio).
 */

/** Latest protocol revision this server speaks. Echoed back if a client asks. */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** A tool the agent may call. `schema` validates the arguments before dispatch. */
export interface McpTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** JSON Schema for the arguments, advertised in `tools/list`. */
  inputSchema: Record<string, unknown>;
  handler: (args: z.infer<S>, signal?: AbortSignal) => Promise<unknown> | unknown;
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: McpTool[];
  /** Aborting this stops the serve loop after the in-flight message. */
  signal?: AbortSignal | undefined;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP `tools/call` result: content the model sees, plus an in-band error flag. */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// Standard JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export class McpServer {
  private readonly tools: McpTool[];
  private readonly name: string;
  private readonly version: string;
  private readonly signal: AbortSignal | undefined;

  constructor(opts: McpServerOptions) {
    this.tools = opts.tools;
    this.name = opts.name;
    this.version = opts.version;
    this.signal = opts.signal;
  }

  /**
   * Handle a single decoded JSON-RPC message.
   *
   * Returns the response to write back, or `null` for a notification (a request
   * with no `id`), which by JSON-RPC must never be answered — even on error.
   */
  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = request?.id === undefined;
    const id = request?.id ?? null;

    if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return isNotification ? null : error(id, INVALID_REQUEST, 'Invalid Request');
    }

    const { method, params } = request;
    try {
      switch (method) {
        case 'initialize':
          return ok(id, this.initializeResult(params));
        case 'ping':
          return ok(id, {});
        case 'tools/list':
          return ok(id, { tools: this.toolList() });
        case 'tools/call':
          return ok(id, await this.callTool(params));
        default:
          // Unknown notifications (e.g. notifications/initialized, .../cancelled)
          // are ignored; unknown requests get a method-not-found error.
          return isNotification ? null : error(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    } catch (err) {
      // A thrown error here is an internal fault, not a tool-level failure (those
      // are reported in-band via isError). Redact: the message could echo input.
      return isNotification ? null : error(id, INTERNAL_ERROR, redactString(messageOf(err)));
    }
  }

  private initializeResult(params: unknown): Record<string, unknown> {
    // Speak the client's requested revision when it names one, so we interoperate
    // with older clients; otherwise advertise our latest.
    const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    return {
      protocolVersion: typeof requested === 'string' ? requested : DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: this.name, version: this.version },
    };
  }

  private toolList(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  private async callTool(params: unknown): Promise<ToolResult> {
    const name = (params as { name?: unknown } | undefined)?.name;
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      return toolError(`Unknown tool: ${typeof name === 'string' ? name : String(name)}`);
    }

    const rawArgs = (params as { arguments?: unknown }).arguments ?? {};
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return toolError(`Invalid arguments for ${tool.name}: ${redactString(parsed.error.message)}`);
    }

    try {
      const data = await tool.handler(parsed.data, this.signal);
      // Redact tool output too: this is a fresh egress channel, and a Kite
      // response or error could carry a value we treat as secret. (Redaction
      // invariant — see src/core/redact.ts.)
      return { content: [{ type: 'text', text: JSON.stringify(redact(data)) }] };
    } catch (err) {
      // Tool failures are surfaced to the model in-band, so it can react (retry a
      // different symbol, tell the user to log in), not as a transport error.
      return toolError(redactString(messageOf(err)));
    }
  }

  /**
   * Read newline-delimited JSON-RPC from `input` and write responses to
   * `output`, until the input closes or the abort signal fires.
   */
  async serve(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    const onAbort = () => rl.close();
    this.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed === '') continue;

        let response: JsonRpcResponse | null;
        let request: JsonRpcRequest;
        try {
          request = JSON.parse(trimmed) as JsonRpcRequest;
        } catch {
          response = error(null, PARSE_ERROR, 'Parse error');
          output.write(`${JSON.stringify(response)}\n`);
          continue;
        }

        response = await this.handle(request);
        if (response) output.write(`${JSON.stringify(response)}\n`);
        if (this.signal?.aborted) break;
      }
    } finally {
      this.signal?.removeEventListener('abort', onAbort);
      rl.close();
    }
  }
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
