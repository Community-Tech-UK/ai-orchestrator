import type { AcpToolCallStatus } from '../../../shared/types/cli.types';
import { isActiveAcpToolCallStatus, isBackgroundAcpTask, isDelegatedAcpTask } from './acp-prompt-timeout-policy';
import { getLogger } from '../../logging/logger';

const logger = getLogger('AcpDelegatedTaskLiveness');

export interface AcpChildActivity {
  sessionId: string;
  title: string;
  createdAt: number;
  /** Native active parent ToolPart.callID, never inferred from title alone. */
  toolCallId?: string;
}

export interface AcpChildProgressSource {
  start(parentSessionId: string, onProgress: (activity: AcpChildActivity) => void,
    onBackground?: (activity: AcpChildActivity) => void): () => void;
}

interface Task {
  startedAt: number;
  progressAt: number;
  parentProgressAt: number;
  nativeBackground?: boolean;
  description?: string;
  sessionId?: string;
  childProgressAt?: number;
}

/** Actual work evidence owns task inactivity; bytes/connection heartbeats do not. */
export class AcpDelegatedTaskLiveness {
  private readonly tasks = new Map<string, Task>();
  private stopSource?: () => void;
  private generation = 0;
  private parentSessionId: string | null = null;

  constructor(private readonly source?: AcpChildProgressSource, private readonly onProgress?: () => void) {}

  observe(id: string, call: { status: AcpToolCallStatus; kind?: string; title?: string; rawInput?: Record<string, unknown> }, parentId: string | null): void {
    if (!isActiveAcpToolCallStatus(call.status) || isBackgroundAcpTask(call.rawInput)) {
      this.tasks.delete(id);
      if ([...this.tasks.values()].every((task) => task.nativeBackground)) this.stop();
      return;
    }
    const previous = this.tasks.get(id);
    if (!previous && !isDelegatedAcpTask(call)) return;
    const now = Date.now();
    this.parentSessionId = parentId;
    const description = call.rawInput?.['description'];
    const sessionId = call.rawInput?.['task_id'] ?? call.rawInput?.['sessionId'];
    this.tasks.set(id, {
      startedAt: previous?.startedAt ?? now,
      progressAt: now,
      parentProgressAt: now,
      nativeBackground: previous?.nativeBackground,
      description: typeof description === 'string' ? description : previous?.description,
      sessionId: typeof sessionId === 'string' ? sessionId : previous?.sessionId,
      childProgressAt: previous?.childProgressAt,
    });
    if (parentId && this.source && !this.stopSource && !previous?.nativeBackground) {
      const generation = this.generation;
      this.stopSource = this.source.start(parentId,
        (child) => { if (generation === this.generation) this.progress(child); },
        (child) => { if (generation === this.generation) this.background(child); });
    }
  }

  private background(child: AcpChildActivity): void {
    if (!child.toolCallId) return;
    const task = this.tasks.get(child.toolCallId);
    if (!task || task.nativeBackground || (task.sessionId && task.sessionId !== child.sessionId)) return;
    task.nativeBackground = true;
    task.sessionId = child.sessionId;
    // A promoted child cannot leave its last foreground renewal in force.
    task.progressAt = task.parentProgressAt;
    task.childProgressAt = undefined;
    if ([...this.tasks.values()].every((entry) => entry.nativeBackground)) this.stop();
    this.onProgress?.();
  }

  private progress(child: AcpChildActivity): void {
    let advanced = false;
    let candidates: Task[];
    if (child.toolCallId) {
      const task = this.tasks.get(child.toolCallId);
      const alreadyOwned = [...this.tasks.entries()].some(([id, other]) => id !== child.toolCallId && other.sessionId === child.sessionId);
      candidates = task && !task.nativeBackground && !alreadyOwned && (!task.sessionId || task.sessionId === child.sessionId) ? [task] : [];
    } else {
      candidates = [...this.tasks.values()].filter((task) => !task.nativeBackground && (task.sessionId ? task.sessionId === child.sessionId
        : child.createdAt >= task.startedAt && task.description !== undefined
          && (child.title === task.description || child.title.startsWith(`${task.description} (@`))));
    }
    // Same descriptions are not evidence of ownership: fail closed until a task_id exists.
    if (candidates.length !== 1) return;
    for (const task of candidates) {
      task.sessionId = child.sessionId;
      task.progressAt = Date.now();
      task.childProgressAt = task.progressAt;
      logger.debug('ACP delegated lease refreshed', {
        parentSessionId: this.parentSessionId, childSessionId: child.sessionId,
        lastChildActivityAt: task.childProgressAt, leaseRefreshSource: 'child-event',
      });
      advanced = true;
    }
    if (advanced) this.onProgress?.();
  }

  leaseMs(defaultLeaseMs: number, inactiveMs: number, absoluteMs: number): number {
    if (this.tasks.size === 0) return defaultLeaseMs;
    const now = Date.now();
    const foreground = [...this.tasks.values()].filter((task) => !task.nativeBackground);
    if (foreground.length === 0) {
      // Until ACP settles its stale foreground call, use ordinary parent inactivity.
      const lastParentProgress = Math.max(...[...this.tasks.values()].map((task) => task.parentProgressAt));
      return Math.max(1, Math.min(defaultLeaseMs, lastParentProgress + inactiveMs - now));
    }
    let remaining = Number.POSITIVE_INFINITY;
    for (const task of foreground) {
      remaining = Math.min(remaining, task.progressAt + inactiveMs - now, task.startedAt + absoluteMs - now);
    }
    return Math.max(1, remaining);
  }

  describe(inactiveMs: number, absoluteMs: number): { childActivity: 'observed' | 'none'; leaseRemainingMs: number; lastChildActivityAgeMs?: number } | undefined {
    const foreground = [...this.tasks.values()].filter((task) => !task.nativeBackground);
    if (foreground.length === 0) return undefined;
    const now = Date.now();
    const latestChildActivity = Math.max(...foreground.map((task) => task.childProgressAt ?? Number.NEGATIVE_INFINITY));
    return {
      childActivity: Number.isFinite(latestChildActivity) ? 'observed' : 'none',
      ...(Number.isFinite(latestChildActivity) ? { lastChildActivityAgeMs: Math.max(0, now - latestChildActivity) } : {}),
      leaseRemainingMs: this.leaseMs(inactiveMs, inactiveMs, absoluteMs),
    };
  }

  clear(): void {
    this.tasks.clear();
    this.parentSessionId = null;
    this.stop();
  }

  private stop(): void {
    this.generation++;
    this.stopSource?.();
    this.stopSource = undefined;
  }
}
