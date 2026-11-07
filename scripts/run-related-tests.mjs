#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { startVitest } from 'vitest/node';

// With a path, also write Vitest's JSON report there, which a run on another machine brings back.
const reportPath = process.argv[2];

let ctx;
try {
  const files = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !file.trim())) {
    throw new Error('Related test input must be an array of nonempty source paths');
  }
  // An empty related list must never fall back to running the full suite.
  if (files.length) {
    ctx = await startVitest('test', [], {
      related: [...new Set(files)],
      run: true,
      passWithNoTests: true,
      ...(reportPath ? { reporters: ['default', 'json'], outputFile: { json: reportPath } } : {}),
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  // startVitest closes successful non-watch runs, but can return early on errors.
  await ctx?.close();
}
