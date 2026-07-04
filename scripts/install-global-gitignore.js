#!/usr/bin/env node
/* eslint-env node */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Local runtime artifacts the harness writes into whatever repo it runs against.
// They must never be committed, so we ensure they are ignored globally (across
// every repo on the machine) rather than relying on each repo's .gitignore.
const MANAGED_HEADER = '# AI Orchestrator / harness local runtime artifacts';
const MANAGED_PATTERNS = ['.ao/'];

// Expand a leading `~` to the user's home directory. Git stores excludesfile
// paths verbatim, so a `~/...` value would otherwise be treated as a relative
// path and silently miss the real file.
function expandHome(filePath, homedir) {
  if (filePath === '~') {
    return homedir;
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(homedir, filePath.slice(2));
  }
  return filePath;
}

// Resolve the global git ignore file. Honour an explicitly-configured
// core.excludesfile; otherwise fall back to git's documented default of
// $XDG_CONFIG_HOME/git/ignore (with XDG defaulting to ~/.config).
function resolveGlobalIgnorePath(options = {}) {
  const exec = options.execFileSync ?? execFileSync;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();

  let configured = '';
  try {
    configured = String(
      exec('git', ['config', '--global', 'core.excludesfile'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
  } catch {
    // Unset config exits non-zero; fall through to the default location.
    configured = '';
  }

  if (configured) {
    return expandHome(configured, homedir);
  }

  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(homedir, '.config');
  return path.join(base, 'git', 'ignore');
}

// Idempotently ensure every MANAGED_PATTERN is present in the global ignore.
// Patterns already listed (in any section) are left untouched; only genuinely
// missing ones are appended under a labelled section.
function installGlobalGitignore(options = {}) {
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;

  let targetPath;
  try {
    targetPath = options.targetPath ?? resolveGlobalIgnorePath(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Global gitignore not updated: ${message}`);
    return { updated: false, reason: 'resolve-failed' };
  }

  try {
    let existing = '';
    if (existsSync(targetPath)) {
      existing = String(readFileSync(targetPath, 'utf8'));
    }

    const existingLines = new Set(
      existing.split('\n').map((line) => line.trim()),
    );
    const missing = MANAGED_PATTERNS.filter((pattern) => !existingLines.has(pattern));

    if (missing.length === 0) {
      log(`Global gitignore already covers harness artifacts (${targetPath})`);
      return { updated: false, reason: 'already-present', path: targetPath };
    }

    mkdirSync(path.dirname(targetPath), { recursive: true });

    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
    const block = `${MANAGED_HEADER}\n${missing.join('\n')}\n`;
    const separator = existing.length > 0 ? (needsLeadingNewline ? '\n\n' : '\n') : '';
    const next = `${existing}${separator}${block}`;

    writeFileSync(targetPath, next, 'utf8');
    log(`Global gitignore updated with harness artifacts (${targetPath})`);
    return { updated: true, path: targetPath, added: missing };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Global gitignore not updated: ${message}`);
    return { updated: false, reason: 'write-failed', path: targetPath };
  }
}

function main() {
  installGlobalGitignore();
}

if (require.main === module) {
  main();
}

module.exports = {
  MANAGED_HEADER,
  MANAGED_PATTERNS,
  expandHome,
  resolveGlobalIgnorePath,
  installGlobalGitignore,
};
