'use strict';
/**
 * One full run at a time on the Mac, so a PC outage staggers runs rather than starting
 * them together. The lock is a kernel file lock, held by a small helper whose stdin is
 * a pipe from this process. When this process dies for any reason, the pipe closes, the
 * helper exits and the lock is gone, so there is no stale file to clear. Node has no
 * file lock of its own, and macOS has no `flock` command, but it does ship perl.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WAIT_LIMIT_MS = 20 * 60_000;
/** Loops have a 20-minute limit of their own, which the wait must leave room inside. */
const LOOP_WAIT_LIMIT_MS = 5 * 60_000;
const NOTICE_INTERVAL_MS = 60_000;

const HOLD_LOCK = `
use Fcntl qw(:flock);
open(my $lock, '>>', $ARGV[0]) or exit 3;
flock($lock, LOCK_EX) or exit 3;
$| = 1;
print "held\\n";
while (<STDIN>) {}
`;

/**
 * Resolves with `{ release, note }`. `note` is set when the run went ahead without the
 * lock, because waiting forever is worse than two runs at once.
 */
function takeMacTurn({ dir, isLoop, log, waitLimitMs, noticeIntervalMs = NOTICE_INTERVAL_MS }) {
  const limit = waitLimitMs ?? (isLoop ? LOOP_WAIT_LIMIT_MS : WAIT_LIMIT_MS);
  return new Promise((resolve) => {
    let helper;
    try {
      fs.mkdirSync(dir, { recursive: true });
      helper = spawn('perl', ['-e', HOLD_LOCK, path.join(dir, 'mac-turn.lock')], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve({ release: () => {}, note: 'the shared lock could not be taken, so it ran without waiting' });
      return;
    }

    const started = Date.now();
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearInterval(notice);
      clearTimeout(giveUp);
      resolve(outcome);
    };
    const release = () => {
      helper.stdin.end();
      helper.kill();
    };
    const notice = setInterval(() => {
      const minutes = Math.round((Date.now() - started) / 60_000);
      log(`  … waiting for another full run on the Mac to finish (${minutes} min so far)`);
    }, noticeIntervalMs);
    const giveUp = setTimeout(() => {
      release();
      finish({
        release: () => {},
        note: `it stopped waiting for other runs after ${Math.round(limit / 60_000)} min`,
      });
    }, limit);

    helper.stdin.on('error', () => { /* helper already gone */ });
    helper.stdout.once('data', () => finish({ release, note: null }));
    const failed = () => finish({ release: () => {}, note: 'the shared lock could not be taken, so it ran without waiting' });
    helper.on('error', failed);
    helper.on('close', failed);
  });
}

module.exports = { takeMacTurn };
