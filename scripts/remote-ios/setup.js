#!/usr/bin/env node
'use strict';
/**
 * Installs aio-ios and the redirect, or takes them away again with --remove.
 *
 *   node scripts/remote-ios/setup.js [--remove]
 *
 * - ~/.ai-orchestrator/remote-ios/aio-ios and redirect.js link to this repository's copies, so other repositories
 *   need none, and a change here takes effect at once.
 * - ~/.local/bin/aio-ios links there too, so agents can type `aio-ios`.
 * - ~/.local/bin/xcodebuild, xcrun and maestro are copies of shim.sh. Copies, not links: they stand in front of tools
 *   everything on this Mac uses, so they must keep working whatever this checkout has on disk. Run this again after
 *   shim.sh changes. A file there that isn't one of ours is never replaced or removed.
 *
 * ~/.local/bin comes before /usr/bin in the shells Harness's agents use, because ~/.zprofile and ~/.zshrc put it first.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** shim.sh's second line starts with this. */
const MARKER = '\n# aio-ios redirect.';
const SHIMMED = ['xcodebuild', 'xcrun', 'maestro'];

function isOurs(file) {
  try {
    return fs.readFileSync(file, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
}

function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try {
    const stat = fs.lstatSync(at);
    if (!stat.isSymbolicLink()) throw new Error(`${at} exists and isn't a link, so it was left alone`);
    fs.unlinkSync(at);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.symlinkSync(target, at);
}

/** Returns the lines to print. */
function install({ home = os.homedir(), repo = path.resolve(__dirname, '..', '..') } = {}) {
  const here = path.join(repo, 'scripts', 'remote-ios');
  const store = path.join(home, '.ai-orchestrator', 'remote-ios');
  const bin = path.join(home, '.local', 'bin');
  link(path.join(here, 'aio-ios.js'), path.join(store, 'aio-ios'));
  link(path.join(here, 'redirect.js'), path.join(store, 'redirect.js'));
  link(path.join(store, 'aio-ios'), path.join(bin, 'aio-ios'));
  const shim = fs.readFileSync(path.join(here, 'shim.sh'));
  const lines = [`aio-ios: ${path.join(bin, 'aio-ios')}`];
  for (const tool of SHIMMED) {
    const at = path.join(bin, tool);
    if (fs.existsSync(at) && !isOurs(at)) {
      lines.push(`left ${at} alone: it isn't the aio-ios redirect`);
      continue;
    }
    fs.writeFileSync(`${at}.new`, shim, { mode: 0o755 });
    fs.renameSync(`${at}.new`, at);
    lines.push(`redirect: ${at}`);
  }
  return lines;
}

function remove({ home = os.homedir() } = {}) {
  const store = path.join(home, '.ai-orchestrator', 'remote-ios');
  const bin = path.join(home, '.local', 'bin');
  const lines = [];
  for (const tool of SHIMMED) {
    const at = path.join(bin, tool);
    if (isOurs(at)) {
      fs.unlinkSync(at);
      lines.push(`removed ${at}`);
    }
  }
  for (const at of [path.join(bin, 'aio-ios'), path.join(store, 'aio-ios'), path.join(store, 'redirect.js')]) {
    try {
      if (fs.lstatSync(at).isSymbolicLink()) {
        fs.unlinkSync(at);
        lines.push(`removed ${at}`);
      }
    } catch {
      /* not there */
    }
  }
  return lines;
}

if (require.main === module) {
  const lines = process.argv.includes('--remove') ? remove() : install();
  console.log(lines.join('\n'));
}

module.exports = { install, remove };
