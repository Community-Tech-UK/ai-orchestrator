#!/usr/bin/env node
/* eslint-env node */

'use strict';

const { execFileSync } = require('node:child_process');

// git opens the SSH connection for a push, runs pre-push on it, then sends the
// pack over that same connection. Long gates leave it idle long enough for
// GitHub's sshd to drop it, and the pack send then dies on a dead socket.
// Client keepalives keep the connection alive. Only installed when the user has
// no custom core.sshCommand of their own.
const SSH_KEEPALIVE_COMMAND = 'ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=12';

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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Git hooks not installed: ${message}`);
    return { installed: false, reason: 'git-config-failed' };
  }

  try {
    let existingSshCommand = '';
    try {
      existingSshCommand = String(
        exec('git', ['config', '--get', 'core.sshCommand'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim();
    } catch {
      // exit 1: core.sshCommand is unset, which is the expected case.
    }

    if (existingSshCommand) {
      log(`Git SSH keepalives not installed: core.sshCommand already set to "${existingSshCommand}"`);
    } else {
      exec('git', ['config', 'core.sshCommand', SSH_KEEPALIVE_COMMAND], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      log('Git SSH keepalives installed (core.sshCommand)');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Git SSH keepalives not installed: ${message}`);
  }

  return { installed: true };
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
