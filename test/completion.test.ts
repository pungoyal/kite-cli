import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildModel, renderScript } from '../src/commands/completion.js';
import { ExitCode } from '../src/core/errors.js';
import { run } from '../src/run.js';

/** True when a shell binary is on PATH, so its execution test can run. */
function shellPresent(shell: string): boolean {
  try {
    execFileSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Write a generated script to a fresh temp file and return its path. */
function writeScript(shell: 'bash' | 'zsh' | 'fish', script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kite-comp-'));
  const path = join(dir, `kite.${shell}`);
  writeFileSync(path, script);
  return path;
}

/**
 * Completion is generated from the live command tree, so these assert the model
 * reflects real commands (not a hardcoded list) and that each shell script
 * carries the tokens its shell needs. The scripts themselves are exercised by a
 * real bash in development; here we assert structure, which is what can rot.
 */

describe('buildModel', () => {
  it('reflects the real command tree', async () => {
    const model = await buildModel();
    // A representative command from three different groups.
    expect(model.commands).toEqual(expect.arrayContaining(['holdings', 'config', 'completion']));
    // Commander's synthetic `help` command must not leak in.
    expect(model.commands).not.toContain('help');
    // Subcommands are keyed by parent.
    expect(model.subcommands['config']).toEqual(expect.arrayContaining(['set', 'unset', 'show', 'path']));
    expect(model.subcommands['margins']).toEqual(expect.arrayContaining(['order', 'basket', 'charges']));
    // Global flags come straight from applyGlobalOptions.
    expect(model.globalFlags).toEqual(expect.arrayContaining(['--json', '--profile', '--dry-run']));
  });
});

describe('renderScript', () => {
  const model = {
    commands: ['holdings', 'config'],
    subcommands: { config: ['set', 'get'] },
    globalFlags: ['--json', '--profile'],
    descriptions: { holdings: 'Show holdings', config: 'Settings', 'config set': 'Set a value', 'config get': 'Read' },
  };

  it('bash: defines the completion function and registers it', () => {
    const script = renderScript('bash', model);
    expect(script).toContain('complete -F _kite kite');
    expect(script).toContain('config) echo "set get"');
    expect(script).toContain('--json --profile');
  });

  it('zsh: carries the #compdef tag, uses `compadd --`, and caps depth at position 3', () => {
    const script = renderScript('zsh', model);
    expect(script.startsWith('#compdef kite')).toBe(true);
    expect(script).toContain("'holdings:Show holdings'");
    expect(script).toContain('compdef _kite kite');
    // `compadd --` (not a bare `compadd --json`) so zsh treats the flags as
    // candidates rather than its own options.
    expect(script).toContain('compadd -- --json --profile');
    // Subcommands are only offered at the subcommand position.
    expect(script).toContain('(( CURRENT == 3 ))');
  });

  it('fish: guards subcommands so depth stays capped at command → subcommand', () => {
    const script = renderScript('fish', model);
    expect(script).toContain('complete -c kite -n __fish_use_subcommand -a holdings');
    // The `and not …` guard stops a parent re-offering its subcommands once one
    // has been chosen (bare __fish_seen_subcommand_from is true anywhere).
    expect(script).toContain(
      "complete -c kite -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from set get' -a set",
    );
    expect(script).toContain('complete -c kite -l json');
  });

  it('strips quotes and backslashes from descriptions in every shell', () => {
    const dirty = {
      commands: ['x'],
      subcommands: {},
      globalFlags: ['--json'],
      // A raw backslash and apostrophe that would otherwise break the quoting.
      descriptions: { x: "a'b\\c" },
    };
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const script = renderScript(shell, dirty);
      expect(script).not.toContain("a'b");
      expect(script).not.toContain('b\\c');
    }
  });
});

// The generator's routing bugs (wrong candidates at depth, zsh flag parsing) are
// invisible to substring assertions — they only surface when a shell runs the
// script. These execute the real scripts, skipping any shell not installed.
describe('generated scripts execute correctly', () => {
  it.runIf(shellPresent('bash'))('bash: offers subcommands, caps depth, offers flags', async () => {
    const path = writeScript('bash', renderScript('bash', await buildModel()));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash parameter expansion for the harness, not a JS template
    const reply = '"${COMPREPLY[*]}"';
    const harness = [
      `source ${path}`,
      `COMP_WORDS=(kite config ""); COMP_CWORD=2; _kite; printf "SUB:%s\\n" ${reply}`,
      `COMP_WORDS=(kite config set ""); COMP_CWORD=3; _kite; printf "DEEP:[%s]\\n" ${reply}`,
      `COMP_WORDS=(kite --); COMP_CWORD=1; _kite; printf "FLAGS:%s\\n" ${reply}`,
    ].join('\n');
    const out = execFileSync('bash', ['--noprofile', '--norc', '-c', harness], { encoding: 'utf8' });
    expect(out).toMatch(/SUB:.*\bset\b/); // subcommands at the subcommand position
    expect(out).toContain('DEEP:[]'); // nothing past the subcommand — depth capped
    expect(out).toMatch(/FLAGS:.*--json/); // global flags on a leading dash
  });

  it.runIf(shellPresent('zsh'))('zsh: routes to compadd/_describe and caps depth', async () => {
    const path = writeScript('zsh', renderScript('zsh', await buildModel()));
    const harness = [
      'compadd() { print "compadd:$@"; }',
      '_describe() { print "describe:$1"; }',
      'compdef() { : ; }', // stub the trailing `compdef _kite kite`
      `source ${path}`,
      'words=(kite config set ""); CURRENT=4; print DEEP_START; _kite; print DEEP_END',
      'words=(kite config ""); CURRENT=3; _kite',
      'words=(kite "--"); CURRENT=2; _kite',
    ].join('\n');
    const out = execFileSync('zsh', ['-f', '-c', harness], { encoding: 'utf8' });
    expect(out).toMatch(/DEEP_START\nDEEP_END/); // nothing offered between → depth capped
    expect(out).toContain('describe:subcommand'); // subcommands at position 3
    expect(out).toContain('compadd:-- --json'); // flags via `compadd --`
  });

  it.runIf(shellPresent('fish'))('fish: offers subcommands then caps depth', async () => {
    const path = writeScript('fish', renderScript('fish', await buildModel()));
    const at = (line: string) =>
      execFileSync('fish', ['-c', `source ${path}; complete -C'${line}'`], { encoding: 'utf8' });
    expect(at('kite config ')).toMatch(/\bset\b/); // subcommands offered
    expect(at('kite config set ').trim()).toBe(''); // nothing past the subcommand
  });
});

describe('kite completion (end to end)', () => {
  let stdout: PassThrough;
  let stderr: PassThrough;
  let out: string;
  const originalShell = process.env['SHELL'];

  beforeEach(() => {
    stdout = new PassThrough();
    stderr = new PassThrough();
    out = '';
    stdout.on('data', (chunk) => (out += chunk));
  });

  afterEach(() => {
    if (originalShell === undefined) delete process.env['SHELL'];
    else process.env['SHELL'] = originalShell;
  });

  const invoke = (args: string[]) => run({ argv: ['node', 'kite', ...args], streams: { stdout, stderr } });

  it('prints a bash script and exits 0', async () => {
    const code = await invoke(['completion', 'bash']);
    expect(code).toBe(ExitCode.Ok);
    expect(out).toContain('complete -F _kite kite');
  });

  it('rejects an unsupported shell with a usage error', async () => {
    const code = await invoke(['completion', 'tcsh']);
    expect(code).toBe(ExitCode.Usage);
  });

  it('auto-detects the shell from $SHELL when none is given', async () => {
    process.env['SHELL'] = '/opt/homebrew/bin/fish';
    const code = await invoke(['completion']);
    expect(code).toBe(ExitCode.Ok);
    expect(out).toContain('complete -c kite');
  });

  it('errors when the shell cannot be detected and none is given', async () => {
    delete process.env['SHELL'];
    const code = await invoke(['completion']);
    expect(code).toBe(ExitCode.Usage);
  });
});
