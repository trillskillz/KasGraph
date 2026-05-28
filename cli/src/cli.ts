#!/usr/bin/env node
// kasgraph CLI entry — thin shim that wires process I/O into
// `runCommand`. All command logic lives in src/index.ts and its
// siblings so vitest can exercise it without spawning a child
// process.

import process from 'node:process';

import { runCommand } from './index.js';

const argv = process.argv.slice(2);

runCommand(argv, {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`kasgraph: unexpected error\n${message}\n`);
    process.exit(70); // EX_SOFTWARE
  },
);
