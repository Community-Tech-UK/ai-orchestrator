import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../logging/logger';
import type { ActivityDetectionResult, ActivityEntry, ActivityState } from '../../shared/types/activity.types';
import { ACTIVITY_CONSTANTS } from '../../shared/types/activity.types';

const logger = getLogger('ActivityStateDetector');

const {
  ACTIVE_WINDOW_MS,
  READY_THRESHOLD_MS,
  ACTIVITY_INPUT_STALENESS_MS,
  DEDUP_WINDOW_MS,
  ACTIVITY_LOG_MAX_BYTES,
  ACTIVITY_LOG_MAX_ROTATED,
} = ACTIVITY_CONSTANTS;

interface NativeStatusAdapter {
  getSessionStatus?: (instanceId: string) => Promise<string | null>;
}

export class ActivityStateDetector {
  private lastRecordedEntry: ActivityEntry | null = null;
  private pid: number | null = null;
  private adapter: NativeStatusAdapter | null = null;

  constructor(
    private instanceId: string,
    private workspacePath: string,
    private provider: string,
  ) {}

  setPid(pid: number): void {
    this.pid = pid;
  }

  setAdapter(adapter: NativeStatusAdapter): void {
    this.adapter = adapter;
  }

  async detect(): Promise<ActivityDetectionResult> {
    // Level 2: Activity JSONL Log
    const jsonlResult = this.detectFromActivityLog();
    if (jsonlResult) return jsonlResult;

    // Level 2.5: Native CLI Signal
    const nativeResult = await this.detectFromNativeSignal();
    if (nativeResult) return nativeResult;

    // Level 3: Age-Based Decay
    const decayResult = this.detectFromAgeDecay();
    if (decayResult) return decayResult;

    // Level 4: Process Check
    return this.detectFromProcessCheck();
  }

  async recordTerminalActivity(terminalOutput: string): Promise<void> {
    const state = this.classifyTerminalOutput(terminalOutput);
    await this.recordActivityEntry({
      ts: Date.now(),
      state,
      source: 'terminal',
      trigger: terminalOutput.split('\n').slice(-3).join('\n').slice(0, 200),
      provider: this.provider,
    });
  }

  async recordActivityEntry(entry: ActivityEntry): Promise<void> {
    const isActionable = entry.state === 'waiting_input' || entry.state === 'blocked' || entry.state === 'exited';
    if (!isActionable && this.lastRecordedEntry) {
      if (this.lastRecordedEntry.state === entry.state
          && (entry.ts - this.lastRecordedEntry.ts) < DEDUP_WINDOW_MS) {
        return;
      }
    }
    this.lastRecordedEntry = entry;
    this.appendToLog(entry);
  }

  async getLastRecordedActivity(): Promise<ActivityEntry | null> {
    if (this.lastRecordedEntry) return this.lastRecordedEntry;
    return this.readLastLogEntry();
  }

  private detectFromActivityLog(): ActivityDetectionResult | null {
    const entry = this.readLastLogEntry();
    if (!entry) return null;
    const age = Date.now() - entry.ts;
    let state = entry.state;
    if ((state === 'waiting_input' || state === 'blocked') && age > ACTIVITY_INPUT_STALENESS_MS) {
      state = 'idle';
    }
    return {
      state,
      confidence: 'medium',
      staleAfterMs: Math.max(0, ACTIVITY_INPUT_STALENESS_MS - age),
      source: `activity-jsonl (age: ${Math.round(age / 1000)}s)`,
    };
  }

  private detectFromAgeDecay(): ActivityDetectionResult | null {
    const entry = this.lastRecordedEntry;
    if (!entry) return null;
    const age = Date.now() - entry.ts;
    let state: ActivityState;
    if (age < ACTIVE_WINDOW_MS) {
      state = 'active';
    } else if (age < READY_THRESHOLD_MS) {
      state = 'ready';
    } else {
      state = 'idle';
    }
    return {
      state,
      confidence: 'low',
      staleAfterMs: age < ACTIVE_WINDOW_MS ? ACTIVE_WINDOW_MS - age : 0,
      source: `age-decay (age: ${Math.round(age / 1000)}s)`,
    };
  }

  private detectFromProcessCheck(): ActivityDetectionResult {
    // PID <= 0 means remote instance (RemoteCliAdapter returns -1) or unset.
    // process.kill(-1, 0) is a dangerous POSIX call that checks ALL user
    // processes — skip it entirely and report unknown/idle instead.
    if (this.pid && this.pid > 0) {
      try {
        process.kill(this.pid, 0);
        return { state: 'idle', confidence: 'low', staleAfterMs: 0, source: 'process-check (alive)' };
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') {
          return { state: 'idle', confidence: 'low', staleAfterMs: 0, source: 'process-check (alive, EPERM)' };
        }
        return { state: 'exited', confidence: 'low', staleAfterMs: 0, source: 'process-check (dead)' };
      }
    }
    if (this.pid !== null && this.pid <= 0) {
      // Remote instance — process runs on worker node, not locally.
      return { state: 'idle', confidence: 'low', staleAfterMs: 0, source: 'process-check (remote, skipped)' };
    }
    return { state: 'exited', confidence: 'low', staleAfterMs: 0, source: 'process-check (no PID)' };
  }

  private async detectFromNativeSignal(): Promise<ActivityDetectionResult | null> {
    try {
      if (!this.adapter?.getSessionStatus) return null;
      const status = await this.adapter.getSessionStatus(this.instanceId);
      if (!status) return null;
      return {
        state: this.mapNativeStatus(status),
        confidence: 'high',
        staleAfterMs: 0,
        source: 'native-cli',
      };
    } catch {
      return null;
    }
  }

  private mapNativeStatus(status: string): ActivityState {
    switch (status) {
      case 'running':
      case 'streaming':
        return 'active';
      case 'waiting':
      case 'idle':
        return 'ready';
      case 'blocked':
      case 'permission':
        return 'waiting_input';
      default:
        return 'ready';
    }
  }

  private classifyTerminalOutput(output: string): ActivityState {
    const lower = output.toLowerCase();
    if (lower.includes('allow execution') || lower.includes('approve') || lower.includes('? y/n')
        || lower.includes('permission') || lower.includes('confirm')) {
      return 'waiting_input';
    }
    if (lower.includes('error:') || lower.includes('fatal:') || lower.includes('panic:')
        || lower.includes('unhandled') || lower.includes('stack trace')) {
      return 'blocked';
    }
    return 'active';
  }

  private get logDir(): string {
    return join(this.workspacePath, '.ao');
  }

  private get logPath(): string {
    return join(this.logDir, 'activity.jsonl');
  }

  private appendToLog(entry: ActivityEntry): void {
    try {
      if (!existsSync(this.logDir)) {
        mkdirSync(this.logDir, { recursive: true });
      }
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.logPath, line, 'utf8');
      this.rotateIfNeeded();
    } catch (err) {
      logger.warn('Failed to append to activity log', { error: String(err), instanceId: this.instanceId });
    }
  }

  private rotateIfNeeded(): void {
    try {
      const stat = statSync(this.logPath);
      if (stat.size <= ACTIVITY_LOG_MAX_BYTES) return;
      for (let i: number = ACTIVITY_LOG_MAX_ROTATED; i >= 1; i--) {
        const src = i === 1 ? this.logPath : `${this.logPath}.${i - 1}`;
        const dst = `${this.logPath}.${i}`;
        if (existsSync(src)) {
          renameSync(src, dst);
        }
      }
    } catch {
      // Best effort rotation
    }
  }

  private readLastLogEntry(): ActivityEntry | null {
    try {
      if (!existsSync(this.logPath)) return null;
      const content = readFileSync(this.logPath, 'utf8');
      const lines = content.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return null;
      return JSON.parse(lastLine) as ActivityEntry;
    } catch {
      return null;
    }
  }
}
