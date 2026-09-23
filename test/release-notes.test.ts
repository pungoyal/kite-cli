import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * scripts/release-notes.mjs turns a CHANGELOG.md section into the GitHub
 * Release body. Run as a child process, the way the release workflow runs it.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'release-notes.mjs');

const CHANGELOG = `# Changelog

## [Unreleased]

## [1.2.0] - 2026-01-02

One-line summary that is
wrapped in the source.

### Fixed

- **A fix.** Its description runs
  over two lines.
  - A nested point.
- Another fix.

\`\`\`bash
kite orders place
  --dry-run
\`\`\`

### Added

- A feature.

## [1.1.0] - 2026-01-01

### Fixed

- Old news.

## [Empty] - 2026-01-01

[Unreleased]: https://example.test/compare/v1.2.0...HEAD
[1.2.0]: https://example.test/compare/v1.1.0...v1.2.0
[1.1.0]: https://example.test/releases/tag/v1.1.0
`;

let dir: string;
let path: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kite-release-notes-'));
  path = join(dir, 'CHANGELOG.md');
  await writeFile(path, CHANGELOG);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const notes = (version: string) => execa('node', [script, version, path], { reject: false });

describe('release-notes script', () => {
  it('renders one section for GitHub, unwrapped and with its compare link', async () => {
    const { stdout, exitCode } = await notes('v1.2.0');
    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      [
        'One-line summary that is wrapped in the source.',
        '',
        '## Fixed',
        '',
        '- **A fix.** Its description runs over two lines.',
        '  - A nested point.',
        '- Another fix.',
        '',
        '```bash',
        'kite orders place',
        '  --dry-run',
        '```',
        '',
        '## Added',
        '',
        '- A feature.',
        '',
        '**Full changelog:** https://example.test/compare/v1.1.0...v1.2.0',
      ].join('\n'),
    );
  });

  it('stops at the next section and accepts a bare version', async () => {
    const { stdout } = await notes('1.1.0');
    expect(stdout).toBe('## Fixed\n\n- Old news.\n\n**Full changelog:** https://example.test/releases/tag/v1.1.0');
  });

  it('fails on a missing or empty section rather than publishing blank notes', async () => {
    const missing = await notes('9.9.9');
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('no "## [9.9.9]" section');
    const empty = await notes('Empty');
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain('is empty');
  });

  it('treats the version literally, not as a pattern', async () => {
    const { exitCode, stderr } = await notes('1.2.0(');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('no "## [1.2.0(]" section');
  });

  it('renders every released section of the real CHANGELOG.md', async () => {
    const versions = [...(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)];
    expect(versions.length).toBeGreaterThan(0);
    for (const [, version] of versions) {
      const { exitCode, stdout } = await execa('node', [script, version!], { reject: false });
      expect(exitCode, version).toBe(0);
      expect(stdout, version).toContain('**Full changelog:**');
    }
  });
});
