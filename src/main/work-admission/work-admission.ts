import { EventEmitter } from 'events';
import { cpus, loadavg } from 'os';
import type { WorkloadLevel } from '../../shared/types/workload-settings.types';
import { limitsFor, type WorkloadLimits } from './workload-policy';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';

const logger = getLogger('WorkAdmission');
export type GlobalWorkPhase = 'none' | 'holding' | 'collecting' | 'ready' | 'resuming';
export type WorkKind = 'queue-job' | 'queue-check' | 'queue-triage' | 'loop-round' | 'campaign-node'
  | 'automation-run' | 'repo-job' | 'helper-agent' | 'consult' | 'background-index' | 'timed-wakeup';
export type AdmissionDecision = { allowed: true } | {
  allowed: false; reason: 'held' | 'paused' | 'over-limit' | 'computer-busy'; detail: string;
};
export interface AdmissionContext { remote?: boolean; activeCount?: number }
interface AdmissionOptions { cpuCount?: () => number; loadAverage?: () => number[] }
interface DeferredWork { kind: WorkKind; run: () => void | Promise<void>; context?: AdmissionContext }

/** One start-of-work policy; counters remain owned by the engines. */
export class WorkAdmission extends EventEmitter {
  private static instance: WorkAdmission | null = null;
  private phase: GlobalWorkPhase = 'none';
  private level: WorkloadLevel = 3;
  private readonly counters = new Map<WorkKind, Set<() => number>>();
  private readonly deferred = new Map<string, DeferredWork>();
  private timer?: ReturnType<typeof setInterval>;
  private settingsCleanup?: () => void;

  constructor(private readonly options: AdmissionOptions = {}) { super(); }

  static getInstance(): WorkAdmission {
    if (!this.instance) this.instance = new WorkAdmission();
    return this.instance;
  }

  static _resetForTesting(): void { this.instance?.dispose(); this.instance = null; }

  /** Bootstrap explicitly, after settings and before engine starts. */
  bootstrap(): void {
    if (this.settingsCleanup) return;
    const settings = getSettingsManager();
    this.setWorkloadLevel(settings.get('workloadLevel') ?? 3);
    const changed = (level: WorkloadLevel): void => this.setWorkloadLevel(level);
    settings.on('setting:workloadLevel', changed);
    this.settingsCleanup = () => settings.off('setting:workloadLevel', changed);
    this.timer = setInterval(() => this.notifyChanged(), 5_000);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.settingsCleanup?.();
    this.settingsCleanup = undefined;
    this.deferred.clear();
    this.removeAllListeners();
  }

  setGlobalPhase(phase: GlobalWorkPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.notifyChanged();
  }

  setWorkloadLevel(level: WorkloadLevel): void {
    if (![1, 2, 3, 4, 5].includes(level)) throw new Error('Workload must be a whole number from 1 to 5.');
    this.level = level;
    this.notifyChanged();
  }

  getWorkloadLevel(): WorkloadLevel { return this.level; }
  getLimits(): WorkloadLimits { return limitsFor(this.level, this.options.cpuCount?.() ?? cpus().length); }
  getCounts(): Partial<Record<WorkKind, number>> {
    return Object.fromEntries([...this.counters.keys()].map(kind => [kind, this.count(kind)]));
  }

  registerCounter(kind: WorkKind, counter: () => number): () => void {
    const counters = this.counters.get(kind) ?? new Set<() => number>();
    counters.add(counter);
    this.counters.set(kind, counters);
    return () => { counters.delete(counter); this.notifyChanged(); };
  }

  check(kind: WorkKind, context: AdmissionContext = {}): AdmissionDecision {
    if (this.phase === 'collecting' || this.phase === 'ready') {
      return { allowed: false, reason: 'paused', detail: 'Harness is paused for restart. Resume before starting new work.' };
    }
    if (this.phase === 'holding' && kind !== 'helper-agent' && kind !== 'consult') {
      return { allowed: false, reason: 'held', detail: 'Holding new work. It will start after Release.' };
    }
    if (context.remote) return { allowed: true };
    const limits = this.getLimits();
    const cap = this.cap(kind, limits);
    const count = cap === null ? 0 : context.activeCount ?? (kind === 'automation-run' || kind === 'repo-job'
      ? this.count('automation-run') + this.count('repo-job') : this.count(kind));
    if (cap !== null && count >= cap) {
      const detail = kind === 'helper-agent'
        ? `Harness is set to a light workload (at most ${cap} helper agents at once). Carry on without one, or try again when one finishes.`
        : 'Waiting for running work to finish at the current workload.';
      return { allowed: false, reason: 'over-limit', detail };
    }
    if (limits.loadPerCore !== null) {
      const threshold = limits.loadPerCore * Math.max(1, this.options.cpuCount?.() ?? cpus().length);
      const [one = 0, five = 0] = this.options.loadAverage?.() ?? loadavg();
      if (one > threshold || five > threshold) return {
        allowed: false, reason: 'computer-busy', detail: 'Waiting for the computer to be less busy.',
      };
    }
    return { allowed: true };
  }

  /** The original callback stays queued until admission allows it; duplicate keys coalesce. */
  defer(key: string, kind: WorkKind, run: () => void | Promise<void>, context?: AdmissionContext): void {
    this.deferred.set(key, { kind, run, context });
    this.flushDeferred();
  }

  cancelDeferred(key: string): void { this.deferred.delete(key); }

  async wait(kind: WorkKind, context: AdmissionContext = {}, signal?: AbortSignal): Promise<void> {
    while (!this.check(kind, context).allowed) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => { this.off('admission-changed', wake); signal?.removeEventListener('abort', abort); clearTimeout(timer); };
        const wake = (): void => { cleanup(); resolve(); };
        const abort = (): void => { cleanup(); reject(signal?.reason ?? new Error('Work cancelled')); };
        const timer = setTimeout(wake, 5_000);
        timer.unref();
        this.once('admission-changed', wake);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    signal?.throwIfAborted();
  }

  notifyChanged(): void { this.emit('admission-changed'); this.flushDeferred(); }

  private flushDeferred(): void {
    for (const [key, work] of this.deferred) {
      if (!this.check(work.kind, work.context).allowed) continue;
      this.deferred.delete(key);
      try { Promise.resolve(work.run()).catch(error => logger.error('Deferred work failed', error instanceof Error ? error : undefined, { key })); }
      catch (error) { logger.error('Deferred work failed', error instanceof Error ? error : undefined, { key }); }
    }
  }

  private count(kind: WorkKind): number {
    return [...(this.counters.get(kind) ?? [])].reduce((total, counter) => total + Math.max(0, counter()), 0);
  }

  private cap(kind: WorkKind, limits: WorkloadLimits): number | null {
    switch (kind) {
      case 'queue-job': return limits.queueJobs;
      case 'queue-check': return limits.queueChecks;
      case 'helper-agent': return limits.helperAgents;
      case 'loop-round': return limits.loopRounds;
      case 'automation-run': case 'repo-job': return limits.scheduledJobs;
      case 'background-index': return limits.backgroundConcurrent;
      default: return null;
    }
  }
}

export function getWorkAdmission(): WorkAdmission { return WorkAdmission.getInstance(); }
