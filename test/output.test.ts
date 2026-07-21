import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { registerSecret } from '../src/core/redact.js';
import { Io, type IoOptions } from '../src/output/io.js';
import { heading, printTable, renderKeyValue, renderTable } from '../src/output/table.js';

/**
 * Output stream discipline and table rendering.
 *
 * The clig.dev contract this enforces: data on stdout, everything else on
 * stderr, `--json`/`--quiet` suppressing notes but never the forced preview or
 * an error. Streams are PassThroughs (never a TTY), which is exactly the piped
 * case the discipline exists for.
 */

function make(opts: Omit<IoOptions, 'streams'> = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => (out += chunk));
  stderr.on('data', (chunk) => (err += chunk));
  const io = new Io({ streams: { stdout, stderr }, ...opts });
  return { io, out: () => out, err: () => err };
}

describe('stream discipline', () => {
  it('writes data to stdout and notes to stderr', () => {
    const { io, out, err } = make();
    io.line('portfolio-data');
    io.note('a note');
    io.info('some info');
    io.error('boom');

    expect(out()).toContain('portfolio-data');
    expect(out()).not.toContain('note');
    expect(err()).toContain('a note');
    expect(err()).toContain('some info');
    expect(err()).toContain('boom');
  });

  it('suppresses notes under --quiet but still emits errors', () => {
    const { io, err } = make({ quiet: true });
    io.note('hidden');
    io.info('hidden');
    io.warn('hidden');
    io.error('shown');

    expect(err()).not.toContain('hidden');
    expect(err()).toContain('shown');
  });

  it('in --json mode keeps notes off the streams and writes a JSON document', () => {
    const { io, out, err } = make({ json: true });
    io.note('note');
    io.writeJson({ ok: true });

    expect(err()).not.toContain('note');
    expect(JSON.parse(out())).toEqual({ ok: true });
  });

  it('forceNote emits even under --quiet, for the order preview', () => {
    const { io, err } = make({ quiet: true });
    io.forceNote('you must see this before confirming');
    expect(err()).toContain('you must see this before confirming');
  });

  it('redacts a registered secret from JSON output', () => {
    const { io, out } = make();
    registerSecret('supersecrettoken1234');
    io.writeJson({ access_token: 'supersecrettoken1234' });
    expect(out()).not.toContain('supersecrettoken1234');
  });
});

describe('colour resolution', () => {
  it('honours an explicit colour mode over the ambient NO_COLOR', () => {
    // The suite runs with NO_COLOR=1; `always` must still win.
    expect(make({ color: 'always' }).io.colorEnabled).toBe(true);
    expect(make({ color: 'never' }).io.colorEnabled).toBe(false);
  });
});

describe('table rendering', () => {
  it('shows an empty-state message when there are no rows', () => {
    const { io } = make();
    const out = renderTable(io, [], [{ header: 'Symbol', value: () => 'x' }], { empty: 'nothing here' });
    expect(out).toContain('nothing here');
  });

  it('renders headers and cell values', () => {
    const { io } = make();
    const out = renderTable(io, [{ symbol: 'INFY' }], [{ header: 'Symbol', value: (r) => r.symbol }]);
    expect(out).toContain('Symbol');
    expect(out).toContain('INFY');
  });

  it('renders aligned key/value pairs', () => {
    const { io } = make();
    const out = renderKeyValue(io, [
      ['Key', 'Value'],
      ['Longer key', 'Second'],
    ]);
    expect(out).toContain('Value');
    expect(out).toContain('Second');
  });

  it('printTable emits JSON, not a table, in --json mode', () => {
    const { io, out } = make({ json: true });
    printTable(io, [{ a: 1 }], [{ header: 'A', value: (r) => String(r.a) }], [{ a: 1 }]);
    expect(JSON.parse(out())).toEqual([{ a: 1 }]);
  });

  it('heading includes the section text', () => {
    const { io } = make();
    expect(heading(io, 'Trading safety')).toContain('Trading safety');
  });
});
