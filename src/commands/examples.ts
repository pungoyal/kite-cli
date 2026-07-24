/**
 * Renders the `Examples:` block appended to a command's `--help`.
 *
 * Every command carries its own examples because a flag list alone does not
 * show how the flags combine — `gtt place` and `alerts create` in particular
 * are unusable from their option names. docs/commands.md is generated from
 * `--help`, so writing them here (rather than in the docs) keeps one source of
 * truth and gets the reference page for free.
 *
 * Commander prints help text verbatim, so alignment is computed here. Two
 * details are load-bearing:
 *
 *  - The leading blank line. The docs generator captures a group command's
 *    subcommand list up to the first blank line, so `Commands:` and `Examples:`
 *    must stay separated.
 *  - The column cap. One long example must not push every other description
 *    off an 80-column terminal, so anything wider drops its description onto
 *    an indented line of its own and is left out of the alignment entirely.
 */

const INDENT = '  ';
const PROMPT = '$ ';
const GAP = 2;
const MAX_COMMAND_WIDTH = 48;
const WRAPPED_INDENT = `${INDENT}    `;

export type Example = readonly [command: string, description: string];

export function examples(rows: readonly Example[]): string {
  const fits = rows
    .map(([command]) => INDENT.length + PROMPT.length + command.length)
    .filter((width) => width <= MAX_COMMAND_WIDTH);
  const column = (fits.length > 0 ? Math.max(...fits) : MAX_COMMAND_WIDTH) + GAP;

  // A block where most commands are too wide to align reads as a mess of one
  // stray aligned line among wrapped ones, so it wraps as a whole instead.
  const wrapEverything = fits.length * 2 < rows.length;

  const lines = rows.map(([command, description]) => {
    const left = `${INDENT}${PROMPT}${command}`;
    if (!description) return left;
    return wrapEverything || left.length + GAP > column
      ? `${left}\n${WRAPPED_INDENT}${description}`
      : left.padEnd(column) + description;
  });

  return `\nExamples:\n${lines.join('\n')}\n`;
}
