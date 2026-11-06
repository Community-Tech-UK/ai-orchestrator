/**
 * Per-turn file baseline.
 *
 * "Changed 4 files while this reply ran" has to come from comparing the folder
 * before and after the turn, not from counting the paths the agent's tool calls
 * mentioned: a formatter, a code generator or a shell one-liner changes files
 * no tool call names, and a tool call can name a file it never changed.
 *
 * When a turn starts (a user message, or input Harness wrote itself) this takes
 * a snapshot of the whole working tree as a git tree object: tracked, modified
 * and untracked files, minus anything ignored. When the turn settles it takes a
 * second snapshot and diffs the two trees. Nothing in the user's repository is
 * touched:
 *  - raw bytes are hashed into a fresh private index;
 *  - every snapshot owns its private blobs and tree; the repository's objects
 *    and refs are not used or written. Split-index enumeration uses private copies.
 *
 * A message that arrives while a turn is still running (a steer) closes the
 * running segment at that moment and opens the next one from the same snapshot,
 * so each segment's comparison covers exactly its own span. Where a baseline
 * cannot be taken (not a git folder, a remote computer, git failed) the result
 * says so; the renderer then shows no count rather than a guessed one.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OutputMessage } from '../../shared/types/instance.types';
import { snapshotWorkingTree, diffTrees, NotAGitFolderError, type WorkingTreeSnapshot } from './turn-snapshot-git';
export { snapshotWorkingTree, diffTrees } from './turn-snapshot-git';
import { turnStartKind } from '../../shared/turn-start';
import type {
  TurnBaselineResult,
  TurnBaselineUnavailableReason,
  TurnFileChange,
} from '../../shared/types/turn-file-changes.types';
import { getLogger } from '../logging/logger';
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';

const logger = getLogger('TurnFileBaseline');

/** Provider writes wait at most this long, including queued work. */
const DISPATCH_WAIT_MS = 2_500;
const MAX_FILES_RETURNED = 200;
const MAX_SEGMENTS_PER_INSTANCE = 32;
const MAX_CONCURRENT_GIT_JOBS = 2;
const OBJECT_DIR_PREFIX = 'aio-turn-objects-';

/**
 * Statuses in which a session is working on a turn, interrupting and respawning
 * included: an interrupted turn goes busy, interrupting, idle, and must still
 * be seen to end, or edits made by hand afterwards would be counted as the
 * agent's.
 */
const WORKING_STATUSES: ReadonlySet<string> = new Set([
  'busy', 'processing', 'thinking_deeply', 'waiting_for_permission',
  'interrupting', 'cancelling', 'interrupt-escalating', 'respawning',
]);
/** Statuses that mean the session has stopped working on its turn. */
const STOPPED_STATUSES: ReadonlySet<string> = new Set([
  'idle', 'ready', 'waiting_for_input', 'cancelled', 'error', 'failed',
]);

export type { TurnBaselineResult, TurnBaselineUnavailableReason, TurnFileChange };

export interface TurnBaselineInstanceInfo {
  workingDirectory: string;
  executionLocation?: { type: string };
}

/** The part of the instance manager this service listens to. */
export interface TurnBaselineEventSource {
  on(event: string, listener: (payload: unknown) => void): unknown;
}

type SnapshotOutcome = WorkingTreeSnapshot | TurnBaselineUnavailableReason;

interface Segment {
  turnKey: string;
  start: Promise<SnapshotOutcome>;
  result: TurnBaselineResult;
  /** Resolves when the comparison now being worked out is done. */
  pending?: Promise<void>;
  /** The provider said the turn finished; a later input no longer moves its end. */
  settled: boolean;
  /** A later input has arrived; this segment is final. */
  closed: boolean;
}

interface InstanceState {
  segments: Segment[];
  /** Only folders created by this state are eligible for deletion. */
  objectDirs: Set<string>;
  prepared?: Promise<SnapshotOutcome>;
  /** Git work for one instance runs in order. */
  chain: Promise<void>;
  lastStatus?: string;
  completionKeys: Set<string>;
}

export interface TurnBaselineDispatchReservation {
  activate(): void;
  release(): Promise<void>;
}

export class TurnFileBaselineService {
  private static instance: TurnFileBaselineService | null = null;

  static getInstance(): TurnFileBaselineService {
    TurnFileBaselineService.instance ??= new TurnFileBaselineService();
    return TurnFileBaselineService.instance;
  }

  static _resetForTesting(): void {
    TurnFileBaselineService.instance?.dispose();
    TurnFileBaselineService.instance = null;
  }

  private readonly instances = new Map<string, InstanceState>();
  private getInstanceInfo: (instanceId: string) => TurnBaselineInstanceInfo | undefined = () => undefined;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  /** Starts listening to the instance manager. Call once at startup. */
  attach(
    source: TurnBaselineEventSource,
    getInstanceInfo: (instanceId: string) => TurnBaselineInstanceInfo | undefined,
  ): void {
    this.getInstanceInfo = getInstanceInfo;
    source.on('provider:normalized-event', (payload) => this.onProviderEvent(payload));
    source.on('instance:state-update', (payload) => this.onStatus(payload));
    source.on('instance:batch-update', (payload) => {
      const updates = (payload as { updates?: unknown } | undefined)?.updates;
      if (Array.isArray(updates)) for (const update of updates) this.onStatus(update);
    });
    source.on('instance:removed', (instanceId) => {
      if (typeof instanceId === 'string') void this.forget(instanceId);
    });
  }

  /** A turn is starting: snapshot the folder as it is right now. */
  beginTurn(instanceId: string, turnKey: string, info?: TurnBaselineInstanceInfo): void {
    const state = this.stateFor(instanceId);
    if (state.segments.some((segment) => segment.turnKey === turnKey)) return;

    const previous = state.segments[state.segments.length - 1];
    if (previous?.settled) state.lastStatus = undefined; // a delayed old idle cannot settle the new input
    const start = state.prepared ?? this.capture(instanceId, state, info);
    state.prepared = undefined;
    const segment: Segment = { turnKey, start, result: { state: 'running' }, settled: false, closed: false };
    void start.then((outcome) => {
      if (typeof outcome === 'string') segment.result = { state: 'unavailable', reason: outcome };
    });
    state.segments.push(segment);
    while (state.segments.length > MAX_SEGMENTS_PER_INSTANCE) state.segments.shift();

    if (previous && !previous.closed) {
      previous.closed = true;
      if (!previous.settled) {
        if (state.lastStatus !== undefined && WORKING_STATUSES.has(state.lastStatus)) {
          // An input that arrives while the previous turn is still running (a
          // steer) ends that turn here: this snapshot is where it stopped.
          previous.pending = start.then(async end => {
            await this.compare(previous, end);
            await this.releaseSnapshot(state, await previous.start);
          });
          state.chain = previous.pending.catch(() => undefined);
        } else if (previous.result.state === 'running') {
          // The session was not working when this input came, so the previous
          // turn ended some time ago without a finish being seen. Nothing was
          // snapshotted where it stopped, and whatever changed since is not
          // known to be its doing. Better no count than a wrong one.
          previous.result = { state: 'unavailable', reason: 'no-baseline' };
          void previous.start.then(snapshot => this.releaseSnapshot(state, snapshot));
        }
      }
    }
  }

  /** Awaited at real send seams, including initial and deferred automated input. */
  async beforeDispatch(instanceId: string, info: TurnBaselineInstanceInfo & { outputBuffer: OutputMessage[] }, deferred = false): Promise<TurnBaselineDispatchReservation | undefined> {
    const state = this.stateFor(instanceId);
    let start: Promise<SnapshotOutcome>;
    if (deferred) {
      // The admission callback publishes the input synchronously at native write time.
      // Reserve its already-completed snapshot without publishing/costing an unadmitted input.
      start = this.capture(instanceId, state, info);
      await start;
      return {
        activate: () => { state.prepared = start; },
        release: async () => {
          if (state.prepared === start) state.prepared = undefined;
          if (!state.segments.some(segment => segment.start === start)) await this.releaseSnapshot(state, await start);
        },
      };
    } else {
      let input: OutputMessage | undefined;
      for (let index = info.outputBuffer.length - 1; index >= 0; index -= 1) {
        if (turnStartKind(info.outputBuffer[index])) { input = info.outputBuffer[index]; break; }
      }
      if (!input) return undefined;
      if (!state.segments.some(segment => segment.turnKey === input.id)) this.beginTurn(instanceId, input.id, info);
      const segment = state.segments.find(segment => segment.turnKey === input.id)!;
      if (segment.settled) return undefined; // replay without a new input boundary has no new count
      start = segment.start;
    }
    await start;
    return undefined;
  }

  /** First settlement owns the end. Duplicate complete/status signals never resnapshot. */
  settleTurn(instanceId: string, completionKey?: string): void {
    const state = this.instances.get(instanceId);
    if (state && completionKey) {
      if (state.completionKeys.has(completionKey)) return;
      state.completionKeys.add(completionKey);
      if (state.completionKeys.size > 64) state.completionKeys.delete(state.completionKeys.values().next().value!);
    }
    const segment = state?.segments.at(-1);
    if (!state || !segment || segment.closed || segment.settled) return;
    segment.settled = true;
    const boundary = performance.timeOrigin + performance.now();
    const end = this.capture(instanceId, state, undefined, boundary, segment.start);
    segment.pending = end.then(async snapshot => {
      await this.compare(segment, snapshot);
      await this.releaseSnapshot(state, snapshot);
      await this.releaseSnapshot(state, await segment.start);
    });
    state.chain = segment.pending.catch(() => undefined);
  }

  /**
   * What changed during a turn. Waits, up to a limit, for a comparison that is
   * still being worked out; answers `running` for a turn that has not ended.
   */
  async getResult(instanceId: string, turnKey: string): Promise<TurnBaselineResult> {
    const segment = this.instances.get(instanceId)?.segments.find((candidate) => candidate.turnKey === turnKey);
    if (!segment) return { state: 'unavailable', reason: 'no-baseline' };
    await segment.start;
    if (segment.pending) await segment.pending;
    return segment.result;
  }

  /** Drops everything held for an instance, including its private object folder. */
  async forget(instanceId: string): Promise<void> {
    const state = this.instances.get(instanceId);
    if (!state) return;
    this.instances.delete(instanceId);
    await state.chain;
    await Promise.all([...state.objectDirs].map(dir => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  }

  dispose(): void {
    // `forget` removes the entry before its first await; a Map copes with that mid-iteration.
    for (const instanceId of this.instances.keys()) void this.forget(instanceId);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private onProviderEvent(payload: unknown): void {
    try {
      const envelope = payload as { instanceId?: unknown; adapterGeneration?: number; raw?: { payload?: { id?: unknown } }; event?: { kind?: unknown; status?: unknown } } | undefined;
      const instanceId = envelope?.instanceId;
      if (typeof instanceId !== 'string') return;
      if (envelope?.event?.kind === 'complete') {
        const id = envelope.raw?.payload?.id;
        this.settleTurn(instanceId, typeof id === 'string' ? `${envelope.adapterGeneration ?? 0}:${id}` : undefined);
      } else if (envelope?.event?.kind === 'status') {
        this.onStatus({ instanceId, status: envelope.event.status });
      } else if (envelope?.event?.kind === 'output') {
        const message = toOutputMessageFromProviderEnvelope(
          payload as Parameters<typeof toOutputMessageFromProviderEnvelope>[0],
        );
        if (message && turnStartKind(message)) this.beginTurn(instanceId, message.id);
      }
    } catch (error) {
      logger.warn('Turn baseline could not read a provider event', { error: String(error) });
    }
  }

  private onStatus(payload: unknown): void {
    const update = payload as { instanceId?: unknown; status?: unknown } | undefined;
    if (typeof update?.instanceId !== 'string' || typeof update.status !== 'string') return;
    const state = this.stateFor(update.instanceId);
    const previous = state.lastStatus;
    state.lastStatus = update.status;
    if (previous && WORKING_STATUSES.has(previous) && STOPPED_STATUSES.has(update.status)) {
      this.settleTurn(update.instanceId);
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots and comparison
  // -------------------------------------------------------------------------

  private stateFor(instanceId: string): InstanceState {
    let state = this.instances.get(instanceId);
    if (!state) {
      state = { segments: [], objectDirs: new Set(), completionKeys: new Set(), chain: Promise.resolve() };
      this.instances.set(instanceId, state);
    }
    return state;
  }

  private enqueue<T>(state: InstanceState, task: () => Promise<T>): Promise<T> {
    const run = state.chain.then(async () => {
      await this.acquireSlot();
      try {
        return await task();
      } finally {
        this.releaseSlot();
      }
    });
    state.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async acquireSlot(): Promise<void> {
    if (this.running < MAX_CONCURRENT_GIT_JOBS) {
      this.running += 1;
      return;
    }
    // The slot is handed over by releaseSlot, so the count never overshoots.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }

  private capture(instanceId: string, state: InstanceState, info = this.getInstanceInfo(instanceId), settledAt?: number, baseline?: Promise<SnapshotOutcome>): Promise<SnapshotOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const work = this.enqueue(state, async (): Promise<SnapshotOutcome> => {
      let objectDir: string | undefined;
      try {
        controller.signal.throwIfAborted();
        if (!info?.workingDirectory) return 'no-baseline';
        if (info.executionLocation?.type === 'remote') return 'remote';
        objectDir = await fs.mkdtemp(path.join(os.tmpdir(), OBJECT_DIR_PREFIX));
        state.objectDirs.add(objectDir);
        const start = await baseline;
        const snapshot = await snapshotWorkingTree(info.workingDirectory, objectDir, controller.signal, settledAt, start && typeof start !== 'string' ? start.paths : []);
        controller.signal.throwIfAborted();
        return snapshot;
      } catch (error) {
        if (objectDir) await this.releaseSnapshot(state, { objectDir });
        return error instanceof NotAGitFolderError ? 'not-git' : 'git-error';
      }
    });
    const timeout = new Promise<SnapshotOutcome>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve('git-error'); }, DISPATCH_WAIT_MS);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  private async releaseSnapshot(state: InstanceState, snapshot: SnapshotOutcome | { objectDir: string }): Promise<void> {
    if (typeof snapshot === 'string' || !state.objectDirs.delete(snapshot.objectDir)) return;
    await fs.rm(snapshot.objectDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async compare(segment: Segment, end: SnapshotOutcome): Promise<void> {
    const start = await segment.start;
    if (typeof start === 'string') {
      segment.result = { state: 'unavailable', reason: start };
      return;
    }
    if (typeof end === 'string') {
      segment.result = { state: 'unavailable', reason: end };
      return;
    }
    try {
      const { files, total } = await diffTrees(start, end);
      segment.result = {
        state: 'ready',
        total,
        files: files.slice(0, MAX_FILES_RETURNED),
        truncated: total > MAX_FILES_RETURNED,
        baselineCompletedAt: start.completedAt,
        endedAt: end.completedAt,
      };
    } catch (error) {
      logger.warn('Turn baseline comparison failed', { turnKey: segment.turnKey, error: String(error) });
      segment.result = { state: 'unavailable', reason: 'git-error' };
    }
  }


}

export function getTurnFileBaselineService(): TurnFileBaselineService {
  return TurnFileBaselineService.getInstance();
}

