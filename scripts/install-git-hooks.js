#!/usr/bin/env node
/* eslint-env node */

'use strict';

const { execFileSync } = require('node:child_process');

function installGitHooks(options = {}) {
  const exec = options.execFileSync ?? execFileSync;
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;

  try {
    const insideWorktree = String(
      exec('git', ['rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();

    if (insideWorktree !== 'true') {
      log('Git hooks not installed: not inside a git worktree');
      return { installed: false, reason: 'not-git-worktree' };
    }
  } catch {
    log('Git hooks not installed: not inside a git worktree');
    return { installed: false, reason: 'not-git-worktree' };
  }

  try {
    exec('git', ['config', 'core.hooksPath', '.githooks'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    log('Git hooks installed from .githooks');
    return { installed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Git hooks not installed: ${message}`);
    return { installed: false, reason: 'git-config-failed' };
  }
}

function main() {
  const result = installGitHooks();
  if (result.reason === 'git-config-failed') {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  installGitHooks,
};
