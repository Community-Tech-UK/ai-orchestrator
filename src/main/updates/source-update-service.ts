import { EventEmitter } from 'node:events';
import type { UpdateStatus } from '../../shared/types/update.types';
import type { AutoUpdateInitOptions } from './auto-update-service';
import type { IdleSourceUpdateSession, SourceUpdateMaintenanceLease } from './source-update-maintenance';

export interface SourceUpdateCandidate { commit: string; appPath: string }
export interface SourceUpdateActivation { commit(): Promise<void>; abort(): void }
export interface SourceUpdateDriver {
  probe(request: { installedCommit: string }, signal: AbortSignal): Promise<{ available: boolean; commit?: string }>;
  build(request: { commit: string }, signal: AbortSignal): Promise<SourceUpdateCandidate>;
  prepare(request: SourceUpdateCandidate & { parentPid: number; sessions: IdleSourceUpdateSession[] }, signal: AbortSignal): Promise<SourceUpdateActivation>;
  ack(request: { commit: string; pid: number; restored?: true }, signal: AbortSignal): Promise<{ acknowledged: boolean; sessions: IdleSourceUpdateSession[] }>;
}
export interface SourceUpdateMaintenance {
  isIdle(): boolean;
  tryAcquire(): Promise<SourceUpdateMaintenanceLease | null>;
  restore(sessions: IdleSourceUpdateSession[]): Promise<void>;
  dispose(): void;
}
interface SourceUpdateServiceOptions {
  currentCommit: string;
  currentVersion: string;
  pid: number;
  driver: SourceUpdateDriver;
  maintenance: SourceUpdateMaintenance;
  quit(): void;
}

/** Fetch/build while the old app remains intact; only its owning idle lease permits restart. */
export class SourceUpdateService extends EventEmitter {
  private status: UpdateStatus;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checkInFlight: Promise<UpdateStatus> | null = null;
  private ready = false;
  private disposed = false;
  private committed = false;
  private startupRestored = false;
  private candidate: SourceUpdateCandidate | null = null;
  private activation: SourceUpdateActivation | null = null;
  private lease: SourceUpdateMaintenanceLease | null = null;
  private pollIntervalMs = 60_000;
  private startupDelayMs = 15_000;

  constructor(private readonly options: SourceUpdateServiceOptions) {
    super();
    this.status = { state: 'idle', enabled: false, source: 'git', currentVersion: options.currentVersion };
  }

  initialize(options: AutoUpdateInitOptions): void {
    this.status = { ...this.status, enabled: options.enabled };
    this.startupDelayMs = options.startupDelayMs ?? 15_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
  }

  async markReady(): Promise<void> {
    if (this.ready || this.disposed || !this.status.enabled) return;
    this.ready = true;
    await this.restoreStartup();
    this.schedule(this.startupDelayMs);
  }

  getStatus(): UpdateStatus { return { ...this.status }; }

  checkForUpdates(): Promise<UpdateStatus> {
    if (this.disposed || this.committed || !this.ready || !this.status.enabled) return Promise.resolve(this.getStatus());
    if (this.checkInFlight) return this.checkInFlight;
    this.checkInFlight = this.check().finally(() => { this.checkInFlight = null; });
    return this.checkInFlight;
  }

  downloadUpdate(): Promise<UpdateStatus> { return this.checkForUpdates(); }

  async quitAndInstall(): Promise<boolean> {
    await this.checkForUpdates();
    return this.committed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.status = { ...this.status, enabled: false, state: 'idle' };
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort();
    if (!this.committed) {
      this.activation?.abort();
      this.lease?.release();
      this.options.maintenance.dispose();
    }
    // A committed handoff keeps admission closed through asynchronous app shutdown.
    this.removeAllListeners();
  }

  private async restoreStartup(): Promise<void> {
    if (this.startupRestored || this.disposed) return;
    try {
      const request = { commit: this.options.currentCommit, pid: this.options.pid };
      const restored = await this.options.driver.ack(request, this.controller.signal);
      this.assertLive();
      if (restored.acknowledged) {
        await this.options.maintenance.restore(restored.sessions);
        this.assertLive();
        const consumed = await this.options.driver.ack({ ...request, restored: true }, this.controller.signal);
        this.assertLive();
        if (!consumed.acknowledged) throw new Error('Session restoration was not acknowledged');
      }
      this.startupRestored = true;
    } catch {
      if (!this.disposed) this.publish({ state: 'error', errorContext: 'install',
        error: 'Harness could not finish restoring sessions after its update. It will retry without sending their messages again.' });
    }
  }

  private async check(): Promise<UpdateStatus> {
    let stage: 'check' | 'download' | 'install' = 'check';
    try {
      if (!this.startupRestored) await this.restoreStartup();
      if (!this.startupRestored || this.disposed) return this.getStatus();
      if (!this.candidate) {
        this.publish({ state: 'checking', error: undefined, errorContext: undefined, lastCheckedAt: new Date().toISOString() });
        const result = await this.options.driver.probe({ installedCommit: this.options.currentCommit }, this.controller.signal);
        this.assertLive();
        if (!result.available) {
          this.publish({ state: 'not-available', sourceBuildReady: false });
          return this.getStatus();
        }
        if (!result.commit) throw new Error('Missing candidate commit');
        if (!this.options.maintenance.isIdle()) {
          this.publish({ state: 'waiting-idle', sourceBuildReady: false });
          return this.getStatus();
        }
        stage = 'download';
        this.publish({ state: 'building', sourceBuildReady: false });
        const candidate = await this.options.driver.build({ commit: result.commit }, this.controller.signal);
        this.assertLive();
        if (candidate.commit !== result.commit) throw new Error('Candidate commit differs');
        this.candidate = candidate;
      }
      this.publish({ state: 'waiting-idle', sourceBuildReady: true, error: undefined, errorContext: undefined });
      if (!this.options.maintenance.isIdle()) return this.getStatus();
      stage = 'install';
      this.lease = await this.options.maintenance.tryAcquire();
      this.assertLive();
      if (!this.lease) return this.getStatus();
      this.activation = await this.options.driver.prepare({ ...this.candidate, parentPid: this.options.pid, sessions: this.lease.sessions }, this.controller.signal);
      this.assertLive();
      if (!this.options.maintenance.isIdle() || !this.lease.recheck()) {
        return this.getStatus();
      }
      await this.activation.commit();
      this.assertLive();
      this.committed = true;
      this.options.quit();
    } catch {
      if (!this.disposed) this.publish({ state: 'error', errorContext: stage,
        error: stage === 'check' ? 'Harness could not check for source updates. It will retry.'
          : stage === 'download' ? 'The source build failed. The installed Harness is still running; it will check again.'
          : 'The update could not restart Harness safely. The current app is still running; it will retry when idle.' });
    } finally {
      if (!this.committed) {
        this.activation?.abort();
        this.activation = null;
        this.lease?.release();
        this.lease = null;
      }
    }
    return this.getStatus();
  }

  private assertLive(): void { this.controller.signal.throwIfAborted(); }

  private schedule(delay: number): void {
    if (this.disposed || this.committed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.checkForUpdates().finally(() => this.schedule(this.pollIntervalMs));
    }, delay);
    this.timer.unref?.();
  }

  private publish(patch: Partial<UpdateStatus>): void {
    if (this.disposed) return;
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }
}
