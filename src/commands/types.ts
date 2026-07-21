import type { Command } from 'commander';
import type { Context } from '../context.js';

/**
 * A command handler receives a fully-built context plus its own parsed options.
 *
 * Commander types `.opts<T>()` as a caller-supplied cast rather than inferring
 * from the `.option()` calls, so nothing verifies that `Options` matches what
 * was declared. Commands that take non-trivial input therefore re-validate
 * through a zod schema at the top of the handler, which converts a silent type
 * lie into a runtime guarantee.
 */
export type Handler<Options = Record<string, unknown>> = (
  ctx: Context,
  options: Options,
  command: Command,
) => Promise<void> | void;

/** Wraps a handler so it is given a context and has its errors reported. */
export type Runner = <Options>(handler: Handler<Options>) => (...args: unknown[]) => Promise<void>;

/** Registers a group of related commands on the root program. */
export type CommandFactory = (program: Command, run: Runner) => void;
