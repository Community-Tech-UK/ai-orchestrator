import type {
  NodePlatform,
  RemoteWorkerRejectedRegistration,
} from '../../shared/types/worker-node.types';

const REJECTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REJECTIONS = 200;

interface RecordRejectedRegistrationInput {
  nodeId: string;
  nodeName?: string;
  platformHint?: unknown;
  reason: string;
  now?: number;
}

let instance: RemoteWorkerRepairTracker | null = null;

export class RemoteWorkerRepairTracker {
  private readonly rejected = new Map<string, RemoteWorkerRejectedRegistration>();

  static getInstance(): RemoteWorkerRepairTracker {
    if (!instance) {
      instance = new RemoteWorkerRepairTracker();
    }
    return instance;
  }

  static _resetForTesting(): void {
    instance = null;
  }

  recordRejectedRegistration(input: RecordRejectedRegistrationInput): RemoteWorkerRejectedRegistration {
    const now = input.now ?? Date.now();
    this.prune(now);
    const existing = this.rejected.get(input.nodeId);
    const platformHint = normalizePlatform(input.platformHint) ?? existing?.platformHint;
    const nodeName = sanitizeNodeName(input.nodeName) ?? existing?.nodeName;
    const next: RemoteWorkerRejectedRegistration = {
      nodeId: input.nodeId,
      ...(nodeName ? { nodeName } : {}),
      ...(platformHint ? { platformHint } : {}),
      reason: sanitizeReason(input.reason),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      count: (existing?.count ?? 0) + 1,
    };
    this.rejected.set(input.nodeId, next);
    this.enforceMaxSize();
    return next;
  }

  get(nodeId: string, now = Date.now()): RemoteWorkerRejectedRegistration | undefined {
    this.prune(now);
    return this.rejected.get(nodeId);
  }

  getAll(now = Date.now()): RemoteWorkerRejectedRegistration[] {
    this.prune(now);
    return [...this.rejected.values()];
  }

  clear(nodeId: string): void {
    this.rejected.delete(nodeId);
  }

  private prune(now: number): void {
    for (const [nodeId, rejection] of this.rejected.entries()) {
      if (now - rejection.lastSeenAt > REJECTION_TTL_MS) {
        this.rejected.delete(nodeId);
      }
    }
  }

  private enforceMaxSize(): void {
    while (this.rejected.size > MAX_REJECTIONS) {
      const oldest = [...this.rejected.entries()]
        .sort((left, right) => left[1].firstSeenAt - right[1].firstSeenAt)[0];
      if (!oldest) {
        return;
      }
      this.rejected.delete(oldest[0]);
    }
  }
}

function normalizePlatform(platform: unknown): NodePlatform | undefined {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? platform
    : undefined;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:token|credential|secret|password)\s*[:=]\s*["']?[^\s"']+/gi, (match) => {
      const prefix = match.split(/[:=]/)[0];
      return `${prefix}= [redacted]`;
    })
    .replace(/\b[a-f0-9]{16,}\b/gi, '[redacted]');
}

function sanitizeNodeName(nodeName: string | undefined): string | undefined {
  if (!nodeName) {
    return undefined;
  }
  const sanitized = redactSensitiveText(nodeName.replace(/\s+/g, ' ').trim())
    .slice(0, 120)
    .trimEnd();
  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeReason(reason: string): string {
  const trimmed = reason.trim() || 'Registration rejected';
  return redactSensitiveText(trimmed).slice(0, 240);
}

export function getRemoteWorkerRepairTracker(): RemoteWorkerRepairTracker {
  return RemoteWorkerRepairTracker.getInstance();
}
