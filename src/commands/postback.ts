import { readFile } from 'node:fs/promises';
import type { Context } from '../context.js';
import { verifyPostbackChecksum } from '../core/auth.js';
import { ExitCode, UsageError } from '../core/errors.js';
import { renderKeyValue } from '../output/table.js';
import { examples } from './examples.js';
import type { CommandFactory } from './types.js';

/**
 * `kite postback verify` — check a Kite postback payload offline.
 *
 * Postbacks fire even when the user is not logged in ("Postback API works
 * even when the user is not logged in" — Kite's own docs), so the checksum is
 * the only thing distinguishing a genuine update from a forged one. This
 * wraps the pure `verifyPostbackChecksum` helper (core/auth.ts) — already
 * used for the login handshake's own checksum — for anyone building a
 * receiver of their own. It never talks to Kite; the only I/O is reading the
 * stored API secret used to sign the check.
 */
export const postbackCommands: CommandFactory = (program, run) => {
  const postback = program
    .command('postback')
    .description('Verify a Kite postback payload')
    .addHelpText('after', examples([['kite postback verify < payload.json', 'Is this webhook body genuine?']]));

  postback
    .command('verify')
    .description("Verify a postback payload's checksum against your stored API secret")
    .argument('[file]', 'Path to a JSON file; reads stdin if omitted')
    .addHelpText(
      'after',
      examples([
        ['kite postback verify < payload.json', "Pipe your receiver's raw request body in"],
        ['kite postback verify payload.json', 'Or read it from a file'],
        ['kite postback verify payload.json --json', 'Machine-readable verdict, for a webhook handler'],
      ]),
    )
    .action(run(verifyCommand));
};

async function verifyCommand(ctx: Context, _opts: unknown, command: { args: string[] }): Promise<void> {
  const file = command.args[0];
  const raw = file ? await readFile(file, 'utf8') : await readStdin();

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new UsageError(
      'Could not parse the input as JSON.',
      'Pipe a Kite postback body in, or pass the path to a file containing one.',
    );
  }

  const { orderId, orderTimestamp, checksum } = extractFields(payload);
  const apiSecret = await ctx.requireApiSecret();
  const valid = verifyPostbackChecksum(checksum, orderId, orderTimestamp, apiSecret);

  if (ctx.io.json) {
    ctx.io.writeJson({ valid, order_id: orderId, order_timestamp: orderTimestamp });
  } else if (valid) {
    ctx.io.success(`Checksum matches — this update for order ${ctx.io.bold(orderId)} genuinely came from Kite.`);
  } else {
    ctx.io.error('Checksum does NOT match. Do not trust this payload.');
    ctx.io.line(
      renderKeyValue(ctx.io, [
        ['Order ID', orderId],
        ['Timestamp', orderTimestamp],
      ]),
    );
  }

  if (!valid) process.exitCode = ExitCode.Input;
}

function extractFields(payload: unknown): { orderId: string; orderTimestamp: string; checksum: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new UsageError('The payload must be a JSON object.');
  }
  const obj = payload as Record<string, unknown>;
  return {
    orderId: requireStringField(obj, 'order_id'),
    orderTimestamp: requireStringField(obj, 'order_timestamp'),
    checksum: requireStringField(obj, 'checksum'),
  };
}

function requireStringField(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value === '') {
    throw new UsageError(`The payload is missing a "${field}" string field.`);
  }
  return value;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError(
      'No input given.',
      'Pipe a Kite postback payload in (`kite postback verify < payload.json`), or pass a file path.',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
