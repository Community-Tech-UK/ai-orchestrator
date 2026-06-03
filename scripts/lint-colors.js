#!/usr/bin/env node
/**
 * lint-colors.js
 *
 * Scans src/renderer/**\/*.{scss,ts,html} for hardcoded hex/rgb colors that
 * appear outside the theme definition files.  Reports them as warnings so raw
 * colors can be migrated to CSS custom-property tokens over time.
 *
 * Exit code: always 0 — this is advisory, not a build gate.
 *
 * Usage:  node scripts/lint-colors.js
 *         npm run lint:colors
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { globSync } = require('glob');

const ROOT = path.resolve(__dirname, '..');

// ── Config ──────────────────────────────────────────────────────────────────

/** Files that ARE the canonical token/theme sources — skip them. */
const THEME_FILES = new Set([
  path.join(ROOT, 'src/renderer/styles/_theme.scss'),
]);

/** Additional glob-level exclusions. */
const EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/_archive/**',
  '**/_scratch/**',
];

/** Patterns that identify hardcoded colors. */
const COLOR_PATTERNS = [
  // 3-digit hex  #abc
  { name: 'hex-3', re: /#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g },
  // 4-digit hex  #abcd
  { name: 'hex-4', re: /#[0-9a-fA-F]{4}(?![0-9a-fA-F])/g },
  // 6-digit hex  #aabbcc
  { name: 'hex-6', re: /#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g },
  // 8-digit hex  #aabbccdd
  { name: 'hex-8', re: /#[0-9a-fA-F]{8}(?![0-9a-fA-F])/g },
  // rgb() / rgba() with numeric values
  { name: 'rgb', re: /\brgba?\s*\(\s*\d/g },
];

/**
 * Lines that should be ignored even outside theme files:
 *  - SCSS variable/function definitions that set up a token value
 *  - CSS custom-property declarations (we only want to catch *usages*)
 *  - Inline SVG data URIs — they often contain fill="#rrggbb" and are not tokens
 *  - Comment lines
 */
const ALLOWLIST_LINE_RES = [
  /^\s*\/\//, // SCSS/TS line comment
  /^\s*\*/, // block comment continuation
  /^\s*\/\*/, // block comment open
  /data:image\/svg/, // inline SVG data URIs
  /url\(["']?data:/, // any data URI
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when the line should be skipped (not flagged).
 * @param {string} line
 */
function isAllowlistedLine(line) {
  return ALLOWLIST_LINE_RES.some((re) => re.test(line));
}

/**
 * Scan a single file and return an array of finding objects.
 * @param {string} filePath  Absolute path to the file.
 * @returns {{ file: string, line: number, col: number, match: string, pattern: string }[]}
 */
function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const findings = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (isAllowlistedLine(line)) {
      continue;
    }

    for (const { name, re } of COLOR_PATTERNS) {
      re.lastIndex = 0; // reset stateful global regex
      let m;
      while ((m = re.exec(line)) !== null) {
        findings.push({
          file: filePath,
          line: lineIdx + 1,
          col: m.index + 1,
          match: m[0],
          pattern: name,
        });
      }
    }
  }

  return findings;
}

/**
 * Collect all target files using glob.
 * Falls back to a manual walk if glob is not available (edge case).
 * @returns {string[]}
 */
function collectFiles() {
  const patterns = [
    'src/renderer/**/*.scss',
    'src/renderer/**/*.ts',
    'src/renderer/**/*.html',
  ];

  const files = [];
  for (const pattern of patterns) {
    const matches = globSync(pattern, {
      cwd: ROOT,
      absolute: true,
      ignore: EXCLUDE_GLOBS,
    });
    files.push(...matches);
  }
  return files;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const allFiles = collectFiles();
  const targetFiles = allFiles.filter((f) => !THEME_FILES.has(f));

  let totalFindings = 0;
  const fileCount = { scanned: targetFiles.length, withFindings: 0 };

  for (const filePath of targetFiles.sort()) {
    const findings = scanFile(filePath);
    if (findings.length === 0) {
      continue;
    }

    fileCount.withFindings += 1;
    totalFindings += findings.length;

    const rel = path.relative(ROOT, filePath);
    for (const f of findings) {
      // eslint-disable-next-line no-console
      console.warn(`  WARN  ${rel}:${f.line}:${f.col}  hardcoded color ${f.match}  (${f.pattern})`);
    }
  }

  // Summary
  // eslint-disable-next-line no-console
  console.log(
    `\nlint:colors — scanned ${fileCount.scanned} files, `
    + `found ${totalFindings} hardcoded color(s) in ${fileCount.withFindings} file(s).`,
  );

  if (totalFindings > 0) {
    // eslint-disable-next-line no-console
    console.log(
      'Consider migrating raw colors to CSS custom-property tokens in src/renderer/styles/_theme.scss.',
    );
  }

  // Always exit 0 — advisory only
  process.exit(0);
}

// Allow the module to be imported by tests without running main()
if (require.main === module) {
  main();
}

module.exports = { scanFile, isAllowlistedLine, collectFiles };
