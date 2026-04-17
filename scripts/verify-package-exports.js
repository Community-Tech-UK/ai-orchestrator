#!/usr/bin/env node
/**
 * verify-package-exports.js
 *
 * Fails CI if any source file imports `@contracts`, `@contracts/schemas`,
 * or `@contracts/types` as a blanket barrel. Consumers must use a
 * specific subpath (e.g. `@contracts/schemas/session`).
 *
 * Usage:
 *   node scripts/verify-package-exports.js
 *   npm run verify:exports
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const SCAN_ROOTS = ['src', 'packages/contracts/src', 'packages/sdk/src'];
const EXTENSIONS = new Set(['.ts', '.tsx']);

const SKIP_SUFFIXES = [
  'packages/contracts/src/index.ts',
];

const BANNED_PATTERNS = [
  /from\s+['"]@contracts['"]/g,
  /from\s+['"]@contracts\/schemas['"]/g,
  /from\s+['"]@contracts\/types['"]/g,
  /require\(\s*['"]@contracts['"]\s*\)/g,
  /require\(\s*['"]@contracts\/schemas['"]\s*\)/g,
  /require\(\s*['"]@contracts\/types['"]\s*\)/g,
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.worktrees') {
        continue;
      }
      walk(full, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (EXTENSIONS.has(ext)) out.push(full);
    }
  }
  return out;
}

function collectFiles() {
  const files = [];
  for (const rel of SCAN_ROOTS) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) {
      walk(abs, files);
    }
  }
  return files
    .filter((f) => !SKIP_SUFFIXES.some((suffix) => f.endsWith(suffix)))
    .map((absPath) => ({ path: path.relative(ROOT, absPath), content: fs.readFileSync(absPath, 'utf8') }));
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function scanForBarrelImports(files) {
  const offenders = [];
  for (const { path: filePath, content } of files) {
    for (const pattern of BANNED_PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        offenders.push({ path: filePath, pattern: match[0], line: lineOf(content, match.index) });
      }
    }
  }
  return offenders;
}

function main() {
  const files = collectFiles();
  const offenders = scanForBarrelImports(files);
  if (offenders.length === 0) {
    console.log(`verify:exports — OK (${files.length} files scanned, 0 barrel imports)`);
    process.exit(0);
  }
  console.error(`verify:exports — FAIL: ${offenders.length} barrel import(s) found\n`);
  for (const { path: p, pattern, line } of offenders) {
    console.error(`  ${p}:${line}  ${pattern}`);
  }
  console.error('\nFix: replace the barrel import with an explicit subpath, e.g.');
  console.error(`  import { X } from '@contracts/schemas/session';`);
  console.error(`See docs/superpowers/specs/2026-04-16-ai-orchestrator-cross-repo-improvements-design.md Item 10.`);
  process.exit(1);
}

module.exports = { scanForBarrelImports };

if (require.main === module) {
  main();
}
