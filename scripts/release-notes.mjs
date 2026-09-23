#!/usr/bin/env node
/**
 * Prints the GitHub Release notes for one version, taken from CHANGELOG.md.
 *
 * The changelog is the single source of truth; the release page is a view of
 * it, so the two cannot disagree and nobody has to hand-copy notes at release
 * time. The section is reshaped for GitHub, not rewritten:
 *
 * - `### Fixed` becomes `## Fixed`, since the release title is the top level.
 * - Hard-wrapped prose is unwrapped. GitHub renders a single newline in a
 *   release body as a line break, so 80-column source text would come out
 *   ragged.
 * - The section's compare link is appended as "Full changelog".
 *
 * Usage: node scripts/release-notes.mjs <version|vX.Y.Z> [changelog-path]
 * Zero dependencies, so the release job can run it before `npm ci`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Lines that start their own block and so must never be joined onto the line
// above: list items, headings, quotes, tables and code fences.
const BLOCK_START = /^(\s*([-*+]|\d+\.)\s|#|>|\||```)/;

export function releaseNotes(changelog, version) {
  const lines = changelog.split('\n');
  // A plain prefix match: the version is user input, so it never becomes a regex.
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  // The reference-link definitions at the foot of the file are not notes.
  const body = lines.slice(start + 1, end).filter((l) => !/^\[[^\]]+\]: /.test(l));

  const out = [];
  let inFence = false;
  for (const raw of body) {
    const line = raw.replace(/^###\s/, '## ');
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    const prev = out.at(-1);
    const joinable =
      !inFence &&
      line.trim() !== '' &&
      !BLOCK_START.test(line) &&
      prev !== undefined &&
      prev.trim() !== '' &&
      !/^(#|```|\|)/.test(prev.trimStart());
    if (joinable) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
  }

  const notes = out.join('\n').trim();
  if (notes === '') throw new Error(`CHANGELOG.md section ${version} is empty`);

  const link = lines.find((l) => l.startsWith(`[${version}]: `))?.slice(version.length + 4);
  return link ? `${notes}\n\n**Full changelog:** ${link}\n` : `${notes}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [arg, path = join(root, 'CHANGELOG.md')] = process.argv.slice(2);
  if (!arg) {
    console.error('usage: release-notes.mjs <version> [changelog-path]');
    process.exit(2);
  }
  try {
    process.stdout.write(releaseNotes(readFileSync(path, 'utf8'), arg.replace(/^v/, '')));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
