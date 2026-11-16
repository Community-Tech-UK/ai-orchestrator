import { spawnSync } from 'child_process';

/**
 * A provider CLI runs its shell commands in a process group of their own, so a signal to the CLI's group never
 * reaches them, and once the CLI exits they are re-parented to pid 1 and keep running. On a terminating signal the
 * descendants are therefore listed (`pgrep -P`, which works inside Harness's sandbox where `ps` does not) before the
 * group is signalled, and each one is signalled too. SIGTERM remembers the list so the SIGKILL that follows five
 * seconds later still reaches a descendant that ignored SIGTERM after the CLI is gone.
 */
const MAX_TREE_PIDS = 256;
const MAX_TREE_DEPTH = 8;
const REMEMBER_MS = 60_000;
const rememberedTrees = new Map<number, { pids: number[]; at: number }>();

/** Children of any of these processes, from one `pgrep` call; each call blocks the main thread while it runs. */
function childPids(parents: readonly number[]): number[] {
  // Stopping a session must never fail because the listing did: no listing means the group signal is all we can send.
  try {
    const result = spawnSync('pgrep', ['-P', parents.join(',')], { timeout: 2000, encoding: 'utf8' });
    if (!result || result.status !== 0 || typeof result.stdout !== 'string') return [];
    return result.stdout.split('\n').map(line => Number(line.trim())).filter(value => Number.isInteger(value) && value > 1);
  } catch {
    return [];
  }
}

/** One listing per level of the tree, not one per process. */
function collectDescendants(rootPid: number): number[] {
  const found: number[] = [];
  let frontier = [rootPid];
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0 && found.length < MAX_TREE_PIDS; depth++) {
    const next: number[] = [];
    for (const child of childPids(frontier)) {
      if (!found.includes(child) && child !== rootPid) { found.push(child); next.push(child); }
    }
    frontier = next;
  }
  return found.slice(0, MAX_TREE_PIDS);
}

function signalDescendants(rootPid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' || rootPid <= 1 || (signal !== 'SIGTERM' && signal !== 'SIGKILL')) return;
  const now = Date.now();
  for (const [pid, entry] of rememberedTrees) if (now - entry.at > REMEMBER_MS) rememberedTrees.delete(pid);
  const remembered = rememberedTrees.get(rootPid)?.pids ?? [];
  const pids = [...new Set([...collectDescendants(rootPid), ...remembered])];
  if (signal === 'SIGTERM') rememberedTrees.set(rootPid, { pids, at: now }); else rememberedTrees.delete(rootPid);
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined) return false;
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 5000,
        windowsHide: true,
      });
      if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      }
      return result.status === 0;
    } catch {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
  }

  signalDescendants(pid, signal);
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Signal a POSIX process group and nothing else. For use after the group leader has been
 * reaped: `killProcessGroup`'s single-pid fallback could then reach an unrelated process that
 * reused the leader's pid. False when the group is empty or cannot be signalled, and on Windows.
 */
export function killProcessGroupOnly(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined || pid <= 1 || process.platform === 'win32') return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}
