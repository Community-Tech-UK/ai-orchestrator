import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 14 * DAY_MS;
const DEFAULT_MAX_INACTIVE_DIRECTORIES = 64;
const DEFAULT_MAX_INACTIVE_BYTES = 512 * 1024 * 1024;
const MIN_INACTIVE_AGE_MS = 60 * 1000;
const OWNER_FILE_PATTERN = /^\.owner-([1-9]\d*)$/;
let lastSweepAt = 0;
let spawnsSinceSweep = 0;

interface ForwarderLogCandidate {
  directory: string;
  modifiedAt: number;
  bytes: number;
}

export interface BrowserForwarderLogPruneOptions {
  nowMs?: number;
  maxAgeMs?: number;
  maxInactiveDirectories?: number;
  maxInactiveBytes?: number;
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Mark an active forwarder so parent-side retention never removes its log sink.
 * A crash leaves the marker behind; the next sweep tests whether its PID lives.
 */
export function registerBrowserForwarderLogOwner(logDirectory: string): () => void {
  mkdirSync(logDirectory, { recursive: true });
  const marker = path.join(logDirectory, `.owner-${process.pid}`);
  writeFileSync(marker, '', { mode: 0o600 });
  return () => rmSync(marker, { force: true });
}

/** Sweep at startup, every 100 forwarder spawns, or after ten minutes. */
export function maybePruneBrowserForwarderLogs(rootDirectory: string): { removed: number } {
  spawnsSinceSweep += 1;
  const now = Date.now();
  if (lastSweepAt !== 0 && now - lastSweepAt < 10 * 60 * 1000 && spawnsSinceSweep < 100) {
    return { removed: 0 };
  }
  lastSweepAt = now;
  spawnsSinceSweep = 0;
  return pruneBrowserForwarderLogs(rootDirectory, { nowMs: now });
}

/**
 * Bound inactive browser-forwarder logs without touching active forwarders.
 * Each forwarder already rotates its own app.log at 10 MiB × 5 files; this
 * sweep bounds the cumulative cost of historical instance directories.
 */
export function pruneBrowserForwarderLogs(
  rootDirectory: string,
  options: BrowserForwarderLogPruneOptions = {},
): { removed: number } {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxInactiveDirectories = options.maxInactiveDirectories ?? DEFAULT_MAX_INACTIVE_DIRECTORIES;
  const maxInactiveBytes = options.maxInactiveBytes ?? DEFAULT_MAX_INACTIVE_BYTES;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  let entries;
  try {
    entries = readdirSync(rootDirectory, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }

  const inactive: ForwarderLogCandidate[] = [];
  for (const entry of entries) {
    // Never follow a symlink from this maintenance path.
    if (!entry.isDirectory()) continue;
    const directory = path.join(rootDirectory, entry.name);
    try {
      if (hasLiveOwner(directory, isProcessAlive)) continue;

      const logsDirectory = path.join(directory, 'logs');
      let modifiedAt = statSync(directory).mtimeMs;
      let bytes = 0;
      try {
        for (const file of readdirSync(logsDirectory, { withFileTypes: true })) {
          if (!file.isFile()) continue;
          const stat = statSync(path.join(logsDirectory, file.name));
          bytes += stat.size;
          modifiedAt = Math.max(modifiedAt, stat.mtimeMs);
        }
      } catch {
        // A marker-only directory can still be collected after a crash.
      }
      inactive.push({ directory, modifiedAt, bytes });
    } catch {
      // A concurrent forwarder can remove a marker or directory mid-sweep.
    }
  }

  inactive.sort((a, b) => b.modifiedAt - a.modifiedAt);
  let remainingCount = inactive.length;
  let remainingBytes = inactive.reduce((sum, candidate) => sum + candidate.bytes, 0);
  let removed = 0;
  // Delete oldest first, either past the age limit or to satisfy both caps.
  for (const candidate of inactive.reverse()) {
    const ageMs = nowMs - candidate.modifiedAt;
    // The logger creates the directory before runBrowserMcpForwarder can write
    // its owner marker. A fresh directory is not yet safe to classify as idle.
    if (ageMs < MIN_INACTIVE_AGE_MS) continue;
    if (
      ageMs <= maxAgeMs &&
      remainingCount <= maxInactiveDirectories &&
      remainingBytes <= maxInactiveBytes
    ) continue;
    try {
      // Recheck ownership before deletion; a reconnect may have started since
      // the initial scan.
      if (hasLiveOwner(candidate.directory, isProcessAlive)) continue;
      rmSync(candidate.directory, { recursive: true, force: true });
      remainingCount -= 1;
      remainingBytes -= candidate.bytes;
      removed += 1;
    } catch {
      // Retention is best effort; never make a provider spawn fail on cleanup.
    }
  }
  return { removed };
}

function hasLiveOwner(
  directory: string,
  isProcessAlive: (pid: number) => boolean,
): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = OWNER_FILE_PATTERN.exec(entry.name);
    // PID reuse can retain a crashed forwarder's logs for longer, but marker
    // age cannot prove a process is dead after sleep or a stalled event loop.
    if (match && isProcessAlive(Number(match[1]))) return true;
  }
  return false;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still means the process exists. Unknown failures are treated as
    // live so retention errs on the side of preserving active diagnostics.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
