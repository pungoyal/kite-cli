import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer, type McpTool } from '../src/core/mcp.js';
import { clearRegisteredSecrets, registerSecret } from '../src/core/redact.js';

/**
 * The MCP server is a fresh egress channel for account data, so it gets the
 * same scrutiny as the rest of the transport: correct JSON-RPC framing, no
 * response to notifications, tool failures surfaced in-band, and — the
 * non-negotiable one — registered secrets scrubbed from every tool result.
 */

function echoTool(overrides: Partial<McpTool> = {}): McpTool {
  const schema = z.object({ value: z.string() });
  return {
    name: 'echo',
    description: 'Echo the input back.',
    schema,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    handler: (args: unknown) => args,
    ...overrides,
  };
}

function server(tools: McpTool[] = [echoTool()]): McpServer {
  return new McpServer({ name: 'kite-cli', version: '9.9.9', tools });
}

describe('McpServer.handle', () => {
  it('completes the initialize handshake', async () => {
    const res = await server().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'kite-cli', version: '9.9.9' },
      },
    });
  });

  it('echoes an unknown requested protocol version back to the client', async () => {
    const res = await server().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    // Falls back to the server's default when the client names none.
    expect((res!.result as { protocolVersion: string }).protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('lists tools with their advertised input schema', async () => {
    const res = await server().handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res!.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('echo');
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('answers ping with an empty result', async () => {
    const res = await server().handle({ jsonrpc: '2.0', id: 3, method: 'ping' });
    expect(res).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });

  it('calls a tool and returns its JSON payload as text content', async () => {
    const res = await server().handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'hello' } },
    });
    const result = res?.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ value: 'hello' });
  });

  it('reports an unknown tool as an in-band error, not a transport error', async () => {
    const res = await server().handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    expect(res?.error).toBeUndefined();
    const result = res?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown tool');
  });

  it('reports invalid arguments in-band rather than dispatching', async () => {
    let called = false;
    const tool = echoTool({
      handler: () => {
        called = true;
        return {};
      },
    });
    const res = await server([tool]).handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 123 } }, // wrong type
    });
    const result = res?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });

  it('surfaces a thrown tool error in-band', async () => {
    const tool = echoTool({
      handler: () => {
        throw new Error('Not logged in.');
      },
    });
    const res = await server([tool]).handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'x' } },
    });
    const result = res?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Not logged in');
  });

  it('returns null for a notification (no id), even an unknown one', async () => {
    expect(await server().handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await server().handle({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBeNull();
  });

  it('rejects an unknown request method with -32601', async () => {
    const res = await server().handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
    expect(res?.error?.code).toBe(-32601);
  });

  it('rejects a non-2.0 message with -32600', async () => {
    const res = await server().handle({ jsonrpc: '1.0', id: 9, method: 'ping' });
    expect(res?.error?.code).toBe(-32600);
  });
});

describe('McpServer redaction', () => {
  afterEach(() => clearRegisteredSecrets());

  it('scrubs a registered secret from tool output', async () => {
    registerSecret('super-secret-access-token');
    const tool = echoTool({
      handler: () => ({ token: 'super-secret-access-token', ok: true }),
    });
    const res = await server([tool]).handle({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'x' } },
    });
    const text = (res!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).not.toContain('super-secret-access-token');
  });

  it('scrubs a registered secret from a thrown tool error message', async () => {
    registerSecret('leaky-token-value');
    const tool = echoTool({
      handler: () => {
        throw new Error('failed with token leaky-token-value in the URL');
      },
    });
    const res = await server([tool]).handle({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'x' } },
    });
    const text = (res!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).not.toContain('leaky-token-value');
  });
});

describe('McpServer.serve', () => {
  it('reads newline-delimited requests and writes one response per line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (c) => chunks.push(c.toString()));

    const done = server().serve(input, output);

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    input.end();
    await done;

    const lines = chunks.join('').trimEnd().split('\n').filter(Boolean);
    // Two responses: ping and tools/list. The notification produced none.
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, result: {} });
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 2, result: { tools: expect.any(Array) } });
  });

  it('answers a malformed line with a parse error and keeps going', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (c) => chunks.push(c.toString()));

    const done = server().serve(input, output);
    input.write('this is not json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    input.end();
    await done;

    const lines = chunks.join('').trimEnd().split('\n').filter(Boolean);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: null, error: { code: -32700 } });
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 1, result: {} });
  });
});
