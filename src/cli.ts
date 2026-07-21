#!/usr/bin/env node
import module from 'node:module';

// Node's on-disk compile cache. Cheap to enable and a measurable win on
// startup, which matters for a CLI people run in loops and shell prompts.
module.enableCompileCache?.();

const { run } = await import('./run.js');

process.exitCode = await run();
