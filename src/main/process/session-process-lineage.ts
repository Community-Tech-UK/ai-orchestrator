/**
 * Session process lineage: which Harness session owned each process group.
 *
 * Agent CLIs start their shell commands in fresh process groups (Claude Code
 * and OpenCode in a new session, Codex in a new group), so a session's own
 * group kill never reaches them. When such a command exits, anything it left in
 * the background is reparented to launchd but keeps its process group number.
 * macOS hides the environment of Apple binaries (`yes`, `sleep`, `zsh`), so the
 * `AI_ORCHESTRATOR_INSTANCE_ID` marker cannot identify those leftovers; the
 * group number recorded while the command was still under its session can.
 *
 * The kernel never reuses a group number while any member survives. A group
 * that emptied and was reused by an unrelated program is ruled out by start
 * times: a genuine leftover started no earlier than the first member we saw
 * and no later than shortly after we last saw the group under its session.
 *
 * See docs/plans/2026-10-24-agent-leftover-processes_spec_planned.md.
 */

export interface LineageProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** Process start, in whole seconds since the epoch. */
  startSec: number;
}

export interface LineageEntry {
  instanceId: string;
  /** Earliest start time of any member seen in the group while it was under the session. */
  earliestStartSec: number;
  /** Last time the group was seen under the session. */
  lastSeenSec: number;
}

/** Seconds of rounding slack on either side of a start-time comparison. */
const START_SLACK_SEC = 2;
/** A group with no member seen for this long is forgotten. */
export const LINEAGE_RETENTION_SEC = 24 * 60 * 60;
const MAX_ENTRIES = 20_000;

export class SessionProcessLineage {
  private readonly entries = new Map<number, LineageEntry>();
  private changed = false;

  constructor(private readonly recordIntervalSec: number) {}

  /**
   * Record every group found under a live session root. `liveRoots` maps a
   * session CLI's pid to its instance id; `uid` limits the walk to Harness's
   * own user.
   */
  record(rows: Iterable<LineageProcessRow>, liveRoots: ReadonlyMap<number, string>, uid: number, nowSec: number): void {
    const byPid = new Map<number, LineageProcessRow>();
    const children = new Map<number, number[]>();
    for (const row of rows) {
      byPid.set(row.pid, row);
      const list = children.get(row.ppid) ?? [];
      list.push(row.pid);
      children.set(row.ppid, list);
    }
    for (const [rootPid, instanceId] of liveRoots) {
      const seen = new Set<number>([rootPid]);
      const queue = [rootPid];
      for (let index = 0; index < queue.length; index += 1) {
        for (const childPid of children.get(queue[index]!) ?? []) {
          if (seen.has(childPid)) continue;
          seen.add(childPid);
          queue.push(childPid);
          const child = byPid.get(childPid)!;
          if (child.uid === uid && child.pgid > 1) this.note(child, instanceId, nowSec);
        }
      }
    }
  }

  /** The owning instance of a leftover in `pgid` that started at `startSec`, if the record supports it. */
  attribute(pgid: number, startSec: number): string | undefined {
    const entry = this.entries.get(pgid);
    if (!entry) return undefined;
    if (startSec < entry.earliestStartSec - START_SLACK_SEC) return undefined;
    if (startSec > entry.lastSeenSec + 2 * this.recordIntervalSec + START_SLACK_SEC) return undefined;
    return entry.instanceId;
  }

  /** Forget groups that have no member left and were last seen long ago. */
  prune(livePgids: ReadonlySet<number>, nowSec: number): void {
    for (const [pgid, entry] of this.entries) {
      if (!livePgids.has(pgid) && nowSec - entry.lastSeenSec > LINEAGE_RETENTION_SEC) {
        this.entries.delete(pgid);
        this.changed = true;
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** True once since the last call if the record changed in a way worth persisting. */
  takeChanged(): boolean {
    const changed = this.changed;
    this.changed = false;
    return changed;
  }

  toJSON(): { version: 1; entries: Array<[number, LineageEntry]> } {
    return { version: 1, entries: [...this.entries] };
  }

  /** Restore a persisted record. Malformed entries are skipped, never trusted. */
  load(data: unknown): void {
    if (typeof data !== 'object' || data === null || (data as { version?: unknown }).version !== 1) return;
    const entries = (data as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return;
    for (const item of entries.slice(-MAX_ENTRIES)) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [pgid, entry] = item as [unknown, Partial<LineageEntry> | null];
      if (
        typeof pgid === 'number' && Number.isSafeInteger(pgid) && pgid > 1
        && entry && typeof entry.instanceId === 'string' && entry.instanceId.length > 0
        && Number.isFinite(entry.earliestStartSec) && Number.isFinite(entry.lastSeenSec)
      ) {
        this.entries.set(pgid, {
          instanceId: entry.instanceId,
          earliestStartSec: entry.earliestStartSec!,
          lastSeenSec: entry.lastSeenSec!,
        });
      }
    }
  }

  private note(row: LineageProcessRow, instanceId: string, nowSec: number): void {
    const existing = this.entries.get(row.pgid);
    if (existing && existing.instanceId === instanceId) {
      if (row.startSec < existing.earliestStartSec) existing.earliestStartSec = row.startSec;
      // Persisting every 10 s heartbeat is wasteful; a minute of drift is within the reuse window.
      if (nowSec - existing.lastSeenSec >= 60) this.changed = true;
      existing.lastSeenSec = nowSec;
      return;
    }
    // A different session now owns this number: the old group emptied and the pid was reused.
    this.entries.set(row.pgid, { instanceId, earliestStartSec: row.startSec, lastSeenSec: nowSec });
    this.changed = true;
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
