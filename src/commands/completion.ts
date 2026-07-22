import { Command } from 'commander';
import type { Context } from '../context.js';
import { UsageError } from '../core/errors.js';
import type { CommandFactory, Runner } from './types.js';

/**
 * Shell completion scripts, generated from the live command tree.
 *
 * Rather than hand-maintain a completion file per shell — the exact docs-rot
 * trap a CLI that places real orders cannot afford — this walks the same
 * registration path run() uses (with a no-op runner) and emits command names,
 * subcommand names, and long flags straight from it. A new command or flag is
 * completable as soon as it is added; the only user step is to regenerate after
 * upgrading, the same contract gh, rustup, and kubectl ship.
 *
 * Depth is intentionally capped at command → subcommand + flags, which covers
 * every path this CLI has (`config set`, `margins order`, `orders place`).
 */

const SHELLS = ['bash', 'zsh', 'fish'] as const;
type Shell = (typeof SHELLS)[number];

export const completionCommands: CommandFactory = (program, run) => {
  program
    .command('completion')
    .summary('Print a shell completion script')
    .description(
      'Print a shell completion script for bash, zsh, or fish.\n\n' +
        'The shell is auto-detected from $SHELL when omitted. Install with, e.g.:\n' +
        '  bash   kite completion bash >> ~/.bash_completion\n' +
        '  zsh    kite completion zsh  > ~/.zfunc/_kite   (with ~/.zfunc on your fpath)\n' +
        '  fish   kite completion fish > ~/.config/fish/completions/kite.fish',
    )
    .argument('[shell]', 'Target shell: bash, zsh, or fish')
    .action(run(completion));
};

async function completion(ctx: Context, _opts: unknown, command: Command): Promise<void> {
  const requested = (command.args[0] ?? detectShell())?.toLowerCase();
  if (!requested) {
    throw new UsageError(
      'Could not detect your shell from $SHELL.',
      `Name it explicitly: kite completion <${SHELLS.join('|')}>.`,
    );
  }
  if (!isShell(requested)) {
    throw new UsageError(`Unsupported shell "${requested}".`, `Supported shells: ${SHELLS.join(', ')}.`);
  }

  const model = await buildModel();
  // The script is data: it goes to stdout so `kite completion bash > file`
  // captures exactly the script and nothing else.
  ctx.io.line(renderScript(requested, model));
}

// --- introspection ---------------------------------------------------------

export interface CompletionModel {
  /** Top-level command names (excluding commander's built-in `help`). */
  commands: string[];
  /** Subcommand names keyed by their parent command name. */
  subcommands: Record<string, string[]>;
  /** Long flags valid on every command. */
  globalFlags: string[];
  /** Human descriptions for the shells that render them (zsh, fish). */
  descriptions: Record<string, string>;
}

/**
 * Build the completion model by registering the real command tree onto a
 * throwaway program. The runner is a no-op: completion needs each command's
 * name, options, and subcommands, never its behaviour.
 */
export async function buildModel(): Promise<CompletionModel> {
  const { applyGlobalOptions, registerCommands } = await import('./register.js');
  const program = new Command('kite');
  applyGlobalOptions(program);
  const noop: Runner = () => async () => {};
  await registerCommands(program, noop);

  const descriptions: Record<string, string> = {};
  const subcommands: Record<string, string[]> = {};
  const commands: string[] = [];

  for (const cmd of realCommands(program)) {
    commands.push(cmd.name());
    descriptions[cmd.name()] = summaryOf(cmd);
    const subs = realCommands(cmd);
    if (subs.length > 0) {
      subcommands[cmd.name()] = subs.map((s) => s.name());
      for (const sub of subs) descriptions[`${cmd.name()} ${sub.name()}`] = summaryOf(sub);
    }
  }

  return { commands, subcommands, globalFlags: longFlags(program), descriptions };
}

/** Child commands, minus commander's auto-generated `help` command. */
function realCommands(cmd: Command): Command[] {
  return cmd.commands.filter((c) => c.name() !== 'help');
}

function longFlags(cmd: Command): string[] {
  return cmd.options.map((o) => o.long).filter((long): long is string => Boolean(long));
}

function summaryOf(cmd: Command): string {
  // summary() is the short one-liner; description() may be a multi-line block.
  const text = cmd.summary() || cmd.description().split('\n')[0] || '';
  return sanitize(text);
}

/** Strip characters that would break a quoted description in a shell script. */
function sanitize(text: string): string {
  return text
    .replace(/['\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- rendering -------------------------------------------------------------

export function renderScript(shell: Shell, model: CompletionModel): string {
  switch (shell) {
    case 'bash':
      return renderBash(model);
    case 'zsh':
      return renderZsh(model);
    case 'fish':
      return renderFish(model);
  }
}

function renderBash(model: CompletionModel): string {
  // A `case` for subcommands rather than an associative array, so this works on
  // the bash 3.2 that macOS still ships (declare -A is bash 4+).
  const subCases = Object.entries(model.subcommands)
    .map(([cmd, subs]) => `    ${cmd}) echo "${subs.join(' ')}" ;;`)
    .join('\n');

  return `# kite bash completion. Source it, or install with:
#   kite completion bash >> ~/.bash_completion
_kite_subcommands() {
  case "$1" in
${subCases}
  esac
}

_kite() {
  local cur cmd sub i w
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"

  # First two non-flag words after "kite" are the command and its subcommand.
  cmd=""; sub=""
  for (( i=1; i < COMP_CWORD; i++ )); do
    w="\${COMP_WORDS[i]}"
    [[ "$w" == -* ]] && continue
    if [[ -z "$cmd" ]]; then cmd="$w"; else sub="$w"; break; fi
  done

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "${model.globalFlags.join(' ')}" -- "$cur") )
    return
  fi

  if [[ -z "$cmd" ]]; then
    COMPREPLY=( $(compgen -W "${model.commands.join(' ')}" -- "$cur") )
    return
  fi

  if [[ -z "$sub" ]]; then
    local subs
    subs="$(_kite_subcommands "$cmd")"
    [[ -n "$subs" ]] && COMPREPLY=( $(compgen -W "$subs" -- "$cur") )
  fi
}
complete -F _kite kite
`;
}

function renderZsh(model: CompletionModel): string {
  const topDescribe = model.commands.map((name) => `    '${name}:${model.descriptions[name] ?? ''}'`).join('\n');

  // Build the sub arrays inline per command so descriptions survive.
  const subBlocks = Object.entries(model.subcommands)
    .map(([cmd, subs]) => {
      const described = subs.map((s) => `'${s}:${model.descriptions[`${cmd} ${s}`] ?? ''}'`).join(' ');
      return `    ${cmd}) local -a subs=(${described}); _describe 'subcommand' subs ;;`;
    })
    .join('\n');

  return `#compdef kite
# kite zsh completion. Install with:
#   kite completion zsh > "\${fpath[1]}/_kite"
_kite() {
  local -a commands
  commands=(
${topDescribe}
  )

  if (( CURRENT == 2 )); then
    if [[ \${words[2]} == -* ]]; then
      compadd ${model.globalFlags.join(' ')}
    else
      _describe 'command' commands
    fi
    return
  fi

  case \${words[2]} in
${subBlocks}
  esac
}
compdef _kite kite
`;
}

function renderFish(model: CompletionModel): string {
  const lines: string[] = [
    '# kite fish completion. Install with:',
    '#   kite completion fish > ~/.config/fish/completions/kite.fish',
    '',
    '# No file completion by default; kite takes symbols and subcommands, not paths.',
    'complete -c kite -f',
    '',
    '# Top-level commands (only before a subcommand is typed).',
  ];
  for (const name of model.commands) {
    lines.push(`complete -c kite -n __fish_use_subcommand -a ${name} -d '${model.descriptions[name] ?? ''}'`);
  }
  lines.push('', '# Subcommands.');
  for (const [cmd, subs] of Object.entries(model.subcommands)) {
    for (const sub of subs) {
      const desc = model.descriptions[`${cmd} ${sub}`] ?? '';
      lines.push(`complete -c kite -n '__fish_seen_subcommand_from ${cmd}' -a ${sub} -d '${desc}'`);
    }
  }
  lines.push('', '# Global flags.');
  for (const flag of model.globalFlags) {
    lines.push(`complete -c kite -l ${flag.replace(/^--/, '')}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- helpers ---------------------------------------------------------------

function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}

/** Best-effort shell detection from $SHELL, e.g. "/usr/bin/fish" -> "fish". */
function detectShell(): string | undefined {
  const shell = process.env['SHELL'];
  if (!shell) return undefined;
  const base = shell.split('/').pop();
  return base && isShell(base) ? base : undefined;
}
