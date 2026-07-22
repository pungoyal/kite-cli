import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildModel, renderScript } from '../src/commands/completion.js';
import { ExitCode } from '../src/core/errors.js';
import { run } from '../src/run.js';

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

  it('zsh: carries the #compdef tag and command descriptions', () => {
    const script = renderScript('zsh', model);
    expect(script.startsWith('#compdef kite')).toBe(true);
    expect(script).toContain("'holdings:Show holdings'");
    expect(script).toContain('compdef _kite kite');
  });

  it('fish: emits per-command complete lines', () => {
    const script = renderScript('fish', model);
    expect(script).toContain('complete -c kite -n __fish_use_subcommand -a holdings');
    expect(script).toContain("complete -c kite -n '__fish_seen_subcommand_from config' -a set");
    expect(script).toContain('complete -c kite -l json');
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
