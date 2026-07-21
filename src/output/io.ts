import pc from 'picocolors';
import { redact } from '../core/redact.js';

/**
 * Output context.
 *
 * The contract, per https://clig.dev:
 *   - data goes to stdout, everything else (logs, progress, errors) to stderr
 *   - `--json` forces machine mode even on a TTY, because users eyeball output
 *     before piping it
 *   - stdout.isTTY and stderr.isTTY are checked INDEPENDENTLY; they differ
 *     constantly (`kite quote > file` leaves stderr a TTY)
 */

export interface IoStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface IoOptions {
  json?: boolean;
  color?: 'auto' | 'always' | 'never';
  quiet?: boolean;
  streams?: IoStreams;
}

export class Io {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly stdoutIsTty: boolean;
  readonly stderrIsTty: boolean;
  readonly colorEnabled: boolean;

  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;

  constructor(opts: IoOptions = {}) {
    this.stdout = opts.streams?.stdout ?? process.stdout;
    this.stderr = opts.streams?.stderr ?? process.stderr;

    this.stdoutIsTty = Boolean((this.stdout as NodeJS.WriteStream).isTTY);
    this.stderrIsTty = Boolean((this.stderr as NodeJS.WriteStream).isTTY);

    this.json = opts.json ?? false;
    this.quiet = opts.quiet ?? false;
    this.colorEnabled = resolveColor(opts.color ?? 'auto', this.stdoutIsTty, this.json);
  }

  /** True when the terminal can host a live-updating view. */
  get interactive(): boolean {
    return this.stdoutIsTty && !this.json;
  }

  /** Structured data. Always stdout. */
  write(text: string): void {
    this.stdout.write(text);
  }

  line(text = ''): void {
    this.stdout.write(`${text}\n`);
  }

  /**
   * Emit a JSON document. Values pass through the redactor first, so a stray
   * token in an API payload cannot be printed or piped into a log.
   */
  writeJson(value: unknown): void {
    this.stdout.write(`${JSON.stringify(redact(value), null, this.stdoutIsTty ? 2 : 0)}\n`);
  }

  /** Human-facing notes. Always stderr, so piped stdout stays clean. */
  note(text: string): void {
    if (this.quiet || this.json) return;
    this.stderr.write(`${text}\n`);
  }

  /**
   * Write to stderr even under --quiet or --json.
   *
   * Reserved for output the user must see regardless of what they asked to
   * suppress — specifically the order preview attached to a confirmation
   * prompt. Being asked to approve an order with none of the facts shown is
   * not informed consent, whatever the output mode.
   */
  forceNote(text: string): void {
    this.stderr.write(`${text}\n`);
  }

  info(text: string): void {
    this.note(`${this.dim('·')} ${text}`);
  }

  success(text: string): void {
    this.note(`${this.green('✓')} ${text}`);
  }

  warn(text: string): void {
    if (this.quiet) return;
    this.stderr.write(`${this.yellow('!')} ${text}\n`);
  }

  error(text: string): void {
    this.stderr.write(`${this.red('✗')} ${text}\n`);
  }

  // -- colour helpers, no-ops when colour is disabled ------------------------

  private paint(fn: (s: string) => string, text: string): string {
    return this.colorEnabled ? fn(text) : text;
  }

  bold(text: string): string {
    return this.paint(pc.bold, text);
  }
  dim(text: string): string {
    return this.paint(pc.dim, text);
  }
  red(text: string): string {
    return this.paint(pc.red, text);
  }
  green(text: string): string {
    return this.paint(pc.green, text);
  }
  yellow(text: string): string {
    return this.paint(pc.yellow, text);
  }
  blue(text: string): string {
    return this.paint(pc.blue, text);
  }
  cyan(text: string): string {
    return this.paint(pc.cyan, text);
  }
  magenta(text: string): string {
    return this.paint(pc.magenta, text);
  }
  gray(text: string): string {
    return this.paint(pc.gray, text);
  }

  /** Green for positive, red for negative, plain for zero. */
  signed(value: number, text: string): string {
    if (value > 0) return this.green(text);
    if (value < 0) return this.red(text);
    return text;
  }

  /** Terminal width, with a sane default when stdout is not a TTY. */
  get columns(): number {
    const cols = (this.stdout as NodeJS.WriteStream).columns;
    if (typeof cols === 'number' && cols > 0) return cols;
    const fromEnv = Number(process.env['COLUMNS']);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 80;
  }

  get rows(): number {
    const rows = (this.stdout as NodeJS.WriteStream).rows;
    return typeof rows === 'number' && rows > 0 ? rows : 24;
  }
}

/**
 * Resolve whether colour should be used.
 *
 * NO_COLOR is honoured whenever it is present and non-empty — per the spec it
 * is not parsed for truthiness, so NO_COLOR=0 still disables colour.
 */
function resolveColor(mode: 'auto' | 'always' | 'never', isTty: boolean, json: boolean): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;

  const noColor = process.env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;

  const forceColor = process.env['FORCE_COLOR'];
  if (forceColor !== undefined && forceColor !== '' && forceColor !== '0') return true;

  if (process.env['TERM'] === 'dumb') return false;
  if (json) return false;
  return isTty;
}
