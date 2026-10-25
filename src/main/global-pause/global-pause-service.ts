import { EventEmitter } from 'node:events';
import type { GlobalPauseEntry, GlobalPausePhase, GlobalPauseState } from '@contracts/schemas/global-pause';
import { pauseHelperContext } from './global-pause-prompts';
import { getWorkAdmission } from '../work-admission/work-admission';
import { GlobalPauseStore, type PauseBatch } from './global-pause-store';
import { basicPauseNote, GlobalPauseUnsafeError, type GlobalPauseRuntime, type PauseSessionSnapshot } from './global-pause-runtime.types';

const DAY = 86400000;
interface ServiceDependencies {
  store: GlobalPauseStore;
  runtime: GlobalPauseRuntime;
  setAdmissionPhase?: (phase: GlobalPausePhase) => void;
  now?: () => number;
}

/** Independent from VPN pause: user-authored messages remain usable throughout. */
export class GlobalPauseService extends EventEmitter {
  private static instance: GlobalPauseService | null = null;
  private batch: PauseBatch | null = null;
  private summary: string | null = null;
  private lastFailures: GlobalPauseEntry[] = [];
  private resumeInterrupted = false;
  private operation: Promise<void> | null = null;
  private skip = false;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly collectors = new Map<string, AbortController>();
  private readonly now: () => number;
  private readonly setAdmissionPhase: (phase: GlobalPausePhase) => void;

  constructor(private readonly deps: ServiceDependencies) {
    super();
    this.now = deps.now ?? Date.now;
    this.setAdmissionPhase = deps.setAdmissionPhase ?? ((phase) => getWorkAdmission().setGlobalPhase(phase));
  }

  static getInstance(deps?: ServiceDependencies): GlobalPauseService {
    if (!this.instance) {
      if (!deps) throw new Error('Global pause has not been initialized');
      this.instance = new GlobalPauseService(deps);
    }
    return this.instance;
  }
  static peek(): GlobalPauseService | null { return this.instance; }
  static _resetForTesting(): void { this.instance?.shutdown(); this.instance = null; }

  bootstrap(): void {
    this.batch = this.deps.store.getOpenBatch();
    if (this.batch?.phase === 'collecting') {
      for (const entry of this.entries()) {
        if (entry.kind === 'session' && !['void', 'resumed'].includes(entry.state)) {
          this.deps.store.setEntry(entry.id, { state: 'ready', noteKind: entry.noteText ? entry.noteKind : entry.wasBusy ? 'basic' : 'none',
            noteText: entry.wasBusy ? entry.noteText ?? this.basicNote(entry) : null }, this.now());
        }
      }
      this.changePhase('ready');
    }
    this.resumeInterrupted = this.batch?.phase === 'resuming';
    // A partially resumed batch also waits for James: no work starts automatically at boot.
    this.setAdmissionPhase(this.resumeInterrupted ? 'ready' : this.batch?.phase ?? 'none');
    this.sweep();
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), 6 * 60 * 60 * 1000);
      this.sweepTimer.unref();
    }
    this.publish();
  }

  getState(): GlobalPauseState {
    const entries = this.batch ? this.entries() : this.lastFailures;
    const sessionEntries = entries.filter((entry) => entry.kind === 'session' && entry.state !== 'void');
    const heldEntries = entries.filter((entry) => this.entryHeld(entry));
    const liveAliases = heldEntries.length ? this.deps.runtime.sessions().filter((session) => heldEntries.some((entry) =>
      [entry.targetId, entry.originalInstanceId, entry.historyThreadId, entry.providerSessionId].some((identity) => identity
        && [session.id, session.originalInstanceId, session.historyThreadId, session.providerSessionId].includes(identity)))).map((session) => session.id) : [];
    return { phase: this.batch?.phase ?? 'none', since: this.batch?.since ?? null, reason: this.batch?.reason ?? null,
      batchId: this.batch?.id ?? null, entries, heldInstanceIds: [...new Set([...heldEntries.map((entry) => entry.targetId), ...liveAliases])],
      totalNotes: sessionEntries.filter((entry) => entry.wasBusy).length,
      completedNotes: sessionEntries.filter((entry) => entry.wasBusy && ['ready', 'resumed', 'failed'].includes(entry.state)).length,
      resumeInterrupted: this.resumeInterrupted, stale: this.batch !== null && this.now() - this.batch.since >= 3 * DAY,
      summary: this.summary, ...(this.deps.runtime.runningWork ? { runningWork: this.deps.runtime.runningWork() } : {}) };
  }

  hold(reason = 'Held by James'): GlobalPauseState {
    if (this.batch) return this.getState();
    this.batch = this.deps.store.createBatch('holding', reason, this.now());
    this.setAdmissionPhase('holding'); this.publish(); return this.getState();
  }
  release(): GlobalPauseState {
    if (this.batch?.phase === 'holding') this.finish('discarded', 'New work can start again.');
    return this.getState();
  }

  pauseForRestart(options: { withNotes: boolean }): Promise<void> {
    if (this.operation) return this.operation;
    this.skip = !options.withNotes;
    const operation = this.collect(options.withNotes).finally(() => { if (this.operation === operation) this.operation = null; });
    this.operation = operation;
    return operation;
  }
  skipNotes(): void { this.skip = true; for (const controller of this.collectors.values()) controller.abort(); }

  private async collect(withNotes: boolean): Promise<void> {
    if (this.batch?.phase === 'resuming') return;
    this.summary = null;
    if (!this.batch) this.batch = this.deps.store.createBatch('collecting', null, this.now());
    else {
      this.deps.store.setPhase(this.batch.id, 'collecting', this.now());
      this.batch = { ...this.batch, phase: 'collecting' };
    }
    // Save the new snapshots before any notification can let James pick them up.
    const sessions = this.deps.runtime.sessions();
    for (const session of sessions) this.recordSession(session);
    this.setAdmissionPhase('collecting');
    this.publish();
    try {
      const engines = await this.deps.runtime.engines();
      for (const engine of engines) this.deps.store.refreshSnapshot(this.batch.id, {
        kind: engine.kind, targetId: engine.id, displayName: engine.displayName, wasBusy: true,
        originalInstanceId: engine.originalInstanceId, historyThreadId: engine.historyThreadId, providerSessionId: engine.providerSessionId,
      }, this.now());
      // Runtime pauses queue workers/checkpointers before interrupting anything else.
      await this.deps.runtime.pauseEngines(engines);
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < sessions.length) {
          const session = sessions[cursor++];
          await this.collectSession(session, withNotes);
        }
      };
      const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(5, this.deps.runtime.level())) }, worker));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      this.changePhase('ready');
    } catch (error) {
      // A failed engine checkpoint must never be labelled safe to restart.
      this.summary = `Pause did not finish: ${error instanceof Error ? error.message : String(error)}. Try again before restarting.`;
      this.publish();
      throw error;
    }
  }

  private recordSession(session: PauseSessionSnapshot): void {
    if (!this.batch) return;
    const entry = this.deps.store.refreshSnapshot(this.batch.id, { kind: 'session', targetId: session.id, displayName: session.displayName,
      workspace: session.workspace, provider: session.provider, originalInstanceId: session.originalInstanceId ?? session.id,
      historyThreadId: session.historyThreadId, providerSessionId: session.providerSessionId, wasBusy: session.busy }, this.now(), true);
    // A held session is idle after its note finishes; preserve that unfinished task.
    // Picked-up sessions and newly busy turns instead get a fresh pending snapshot.
    if (entry.wasBusy && !entry.noteText && entry.state === 'pending') {
      this.deps.store.setEntry(entry.id, { noteText: basicPauseNote(session), noteKind: 'basic' }, this.now());
    }
  }
  private async collectSession(session: PauseSessionSnapshot, withNotes: boolean): Promise<void> {
    const entry = this.entries().find((candidate) => candidate.kind === 'session' && candidate.targetId === session.id);
    if (!entry || entry.state === 'void' || entry.state === 'ready') return;
    await this.deps.runtime.stopHelpers(session.id);
    // James may have picked this session up while its helpers were stopping.
    const current = this.entries().find((candidate) => candidate.id === entry.id);
    if (!current || !this.entryHeld(current)) return;
    let note: string | null = null;
    let kind: GlobalPauseEntry['noteKind'] = 'none';
    if (!session.busy && session.waitingForInitialization) await this.deps.runtime.interruptSession(session);
    if (session.busy) {
      const controller = new AbortController(); this.collectors.set(session.id, controller);
      try {
        const canWrite = await this.deps.runtime.interruptSession(session);
        if (withNotes && !this.skip && !session.unavailableReason && canWrite && !controller.signal.aborted) {
          this.deps.store.setEntry(entry.id, { state: 'note-requested' }, this.now()); this.publish();
          note = await this.deps.runtime.collectNote(session, controller.signal);
        }
        kind = note ? 'agent' : 'basic';
        if (note && session.helperReplies.length) note += `\n\n${pauseHelperContext(session.helperReplies)}`;
        note ??= basicPauseNote(session);
      } catch (error) {
        if (error instanceof GlobalPauseUnsafeError) throw error;
        kind = 'basic'; note = basicPauseNote(session);
      }
      finally { this.collectors.delete(session.id); }
    }
    // Manual input/close may have invalidated this session while the note was in flight.
    if (this.entries().find((candidate) => candidate.id === entry.id)?.state !== 'void') {
      this.deps.store.setEntry(entry.id, { noteText: note, noteKind: kind, state: 'ready' }, this.now()); this.publish();
    }
  }

  resume(): Promise<void> {
    if (this.operation) return this.operation;
    if (!this.batch || this.batch.phase === 'holding') return Promise.resolve();
    const operation = this.resumeEntries().finally(() => { if (this.operation === operation) this.operation = null; });
    this.operation = operation; return operation;
  }
  private async resumeEntries(): Promise<void> {
    this.resumeInterrupted = false; this.changePhase('resuming');
    const pending = this.entries().filter((entry) => entry.state !== 'void' && entry.state !== 'resumed' && entry.state !== 'failed');
    let resumed = 0, failed = 0, cursor = 0;
    const resumeEntry = async (entry: GlobalPauseEntry): Promise<void> => {
      if (this.entries().find((candidate) => candidate.id === entry.id)?.state === 'void') return;
      try {
        if (entry.kind === 'session') await this.deps.runtime.resumeSession(entry);
        else await this.deps.runtime.resumeEngine(entry);
        if (this.entries().find((candidate) => candidate.id === entry.id)?.state !== 'void') {
          this.deps.store.setEntry(entry.id, { state: 'resumed', noteText: null }, this.now()); resumed++;
        }
      } catch (error) {
        if (this.entries().find((candidate) => candidate.id === entry.id)?.state !== 'void') {
          this.deps.store.setEntry(entry.id, { state: 'failed', voidReason: error instanceof Error ? error.message : String(error) }, this.now()); failed++;
        }
      }
      this.publish();
    };
    const sessions = pending.filter((entry) => entry.kind === 'session');
    await Promise.all(Array.from({ length: Math.max(1, Math.min(5, this.deps.runtime.level())) }, async () => {
      while (cursor < sessions.length) await resumeEntry(sessions[cursor++]);
    }));
    // Loops must be running again before their campaigns advance.
    for (const kind of ['queue-run', 'loop', 'campaign', 'automation-run', 'repo-job']) {
      for (const entry of pending.filter((candidate) => candidate.kind === kind)) await resumeEntry(entry);
    }
    this.finish('resumed', `Resumed ${resumed} pieces of work${failed ? `; ${failed} could not resume. Reopen those sessions from History by hand.` : '.'}`);
  }

  discard(): GlobalPauseState {
    if (this.operation) throw new Error('Wait for the current pause operation to finish before discarding');
    this.finish('discarded', 'Pause notes deleted. Recorded queue runs, loops and campaigns stay paused.');
    return this.getState();
  }
  holdsAutomaticInput(id: string): boolean {
    const identities = this.deps.runtime.sessionIdentities?.(id) ?? [id];
    return this.entries().some((entry) => this.entryHeld(entry)
      && identities.some((identity) => [entry.targetId, entry.originalInstanceId, entry.historyThreadId, entry.providerSessionId].includes(identity)));
  }
  manualInput(id: string): void { this.voidTarget(id, 'picked-up-by-james'); }
  markInitialPromptQueued(id: string): void {
    const entry = this.entries().find((entry) => entry.kind === 'session' && entry.targetId === id && this.entryHeld(entry));
    if (entry) this.deps.store.setEntry(entry.id, { voidReason: 'initial-prompt-queued' }, this.now());
    this.publish();
  }
  refreshState(): void { this.publish(); }
  bindSessionIdentity(entryId: string, instanceId: string): void {
    this.deps.store.setEntry(entryId, { targetId: instanceId }, this.now()); this.publish();
  }
  voidTarget(id: string, reason: string): void {
    if (!this.batch) return;
    const identities = this.deps.runtime.sessionIdentities?.(id) ?? [id];
    for (const entry of this.entries()) {
      if (identities.some((identity) => [entry.targetId, entry.originalInstanceId, entry.historyThreadId, entry.providerSessionId].includes(identity))) {
        this.collectors.get(entry.targetId)?.abort();
      }
    }
    for (const identity of identities) this.deps.store.voidTarget(identity, reason, this.now());
    this.deps.runtime.targetVoided?.(identities, reason);
    this.publish();
  }
  sweep(): void {
    if (this.batch && this.batch.phase !== 'holding' && !this.operation && this.now() - this.batch.since >= 14 * DAY) {
      this.finish('expired', 'Old pause notes deleted. Recorded queue runs, loops and campaigns stay paused.');
    }
    this.deps.store.purgeEndedBefore(this.now() - 30 * DAY); this.publish();
  }
  shutdown(): void {
    this.skipNotes(); if (this.sweepTimer) clearInterval(this.sweepTimer); this.sweepTimer = undefined;
  }
  private basicNote(entry: GlobalPauseEntry): string {
    return basicPauseNote(this.deps.runtime.sessions().find((session) => session.id === entry.targetId)
      ?? { id: entry.targetId, displayName: entry.displayName, busy: entry.wasBusy, lastRequest: '', lastReply: '', helperReplies: [],
        unavailableReason: 'Harness restarted before the continuation note was finished.' });
  }
  private entries(): GlobalPauseEntry[] { return this.batch ? this.deps.store.entries(this.batch.id) : []; }
  private entryHeld(entry: GlobalPauseEntry): boolean {
    return this.batch !== null && this.batch.phase !== 'holding' && entry.kind === 'session' && !['void', 'resumed', 'failed'].includes(entry.state);
  }
  private changePhase(phase: PauseBatch['phase']): void {
    if (!this.batch) return;
    this.deps.store.setPhase(this.batch.id, phase, this.now()); this.batch = { ...this.batch, phase };
    this.setAdmissionPhase(phase); this.publish();
  }
  private finish(phase: 'resumed' | 'discarded' | 'expired', summary: string): void {
    this.lastFailures = this.entries().filter((entry) => entry.state === 'failed').slice(0, 50).map((entry) => ({ ...entry, noteText: null }));
    if (this.batch) this.deps.store.finishBatch(this.batch.id, phase, this.now());
    this.batch = null; this.summary = summary; this.resumeInterrupted = false; this.setAdmissionPhase('none'); this.publish();
  }
  private publish(): void { this.emit('state-changed', this.getState()); }
}

export function getGlobalPauseService(): GlobalPauseService { return GlobalPauseService.getInstance(); }
export function globalPauseHoldsAutomaticInput(id: string): boolean { return GlobalPauseService.peek()?.holdsAutomaticInput(id) ?? false; }
