import { Notification } from 'electron';
import { getSettingsManager } from '../core/config/settings-manager';
import type {
  NotificationDelivery,
  NotificationRecord,
  NotificationUrgency,
} from '../../shared/types/notification.types';

export type { NotificationDelivery, NotificationRecord, NotificationUrgency } from '../../shared/types/notification.types';

export interface NotificationInput {
  kind: string;
  instanceId?: string;
  title: string;
  body: string;
  urgency?: NotificationUrgency;
  fingerprintFields?: unknown;
  onClick?: () => void;
}

export interface DesktopNotificationPort {
  isSupported(): boolean;
  show(input: Pick<NotificationInput, 'title' | 'body' | 'urgency' | 'onClick'>): void;
}

interface NotificationServiceOptions {
  desktop?: DesktopNotificationPort;
  now?: () => number;
  cooldownMs?: number;
  dedupeWindowMs?: number;
  quietHours?: QuietHours;
  policyReader?: () => Partial<NotificationPolicy>;
}

export interface QuietHours {
  enabled: boolean;
  startHour: number;
  endHour: number;
}

export interface NotificationPolicy {
  cooldownMs: number;
  dedupeWindowMs: number;
  quietHours: QuietHours;
}

interface PendingDigest {
  count: number;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60_000;
const MAX_RECORDS = 500;
const MAX_FINGERPRINTS = 2_000;

const electronDesktopNotificationPort: DesktopNotificationPort = {
  isSupported: () => Notification.isSupported(),
  show: ({ title, body, urgency, onClick }) => {
    const notification = new Notification({
      title,
      body,
      urgency: urgency === 'critical' ? 'critical' : 'normal',
      silent: false,
    });
    if (onClick) notification.on('click', onClick);
    notification.show();
  },
};

/** JSON-compatible stable serialization for notification fingerprint inputs. */
function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export function stableNotificationFingerprint(kind: string, instanceId: string | undefined, fields: unknown = {}): string {
  return stableSerialize({ kind, instanceId: instanceId ?? null, fields });
}

function isWithinQuietHours(now: number, quietHours: QuietHours): boolean {
  if (!quietHours.enabled || quietHours.startHour === quietHours.endHour) return false;
  const hour = new Date(now).getHours();
  if (quietHours.startHour < quietHours.endHour) {
    return hour >= quietHours.startHour && hour < quietHours.endHour;
  }
  return hour >= quietHours.startHour || hour < quietHours.endHour;
}

function digestBody(kind: string, count: number): string {
  if (kind === 'agent-finished') return `${count} agents finished`;
  return `${count} ${kind.replace(/-/g, ' ')} notifications`;
}

/**
 * Central notification policy. Every call creates an in-app-center record;
 * desktop delivery is a best-effort, rate-limited projection of that record.
 */
export class NotificationService {
  private readonly desktop: DesktopNotificationPort;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly dedupeWindowMs: number;
  private readonly quietHours: QuietHours;
  private readonly policyReader?: () => Partial<NotificationPolicy>;
  private readonly records: NotificationRecord[] = [];
  private readonly fingerprintLastSeen = new Map<string, number>();
  private readonly kindLastDesktopDelivery = new Map<string, number>();
  private readonly pendingDigests = new Map<string, PendingDigest>();
  private readonly listeners = new Set<(record: NotificationRecord) => void>();
  private sequence = 0;

  constructor(options: NotificationServiceOptions = {}) {
    this.desktop = options.desktop ?? electronDesktopNotificationPort;
    this.now = options.now ?? Date.now;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.quietHours = options.quietHours ?? { enabled: false, startHour: 22, endHour: 7 };
    this.policyReader = options.policyReader;
  }

  notify(input: NotificationInput): NotificationRecord {
    const now = this.now();
    const policy = this.getPolicy();
    const urgency = input.urgency ?? 'normal';
    const fingerprint = stableNotificationFingerprint(input.kind, input.instanceId, input.fingerprintFields ?? {
      title: input.title,
      body: input.body,
    });
    const record: NotificationRecord = {
      id: `notification-${now}-${++this.sequence}`,
      kind: input.kind,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      title: input.title,
      body: input.body,
      urgency,
      fingerprint,
      createdAt: now,
      delivery: 'desktop-unavailable',
    };

    const lastFingerprint = this.fingerprintLastSeen.get(fingerprint);
    this.fingerprintLastSeen.set(fingerprint, now);
    this.pruneFingerprints(now, policy.dedupeWindowMs);
    if (lastFingerprint !== undefined && now - lastFingerprint < policy.dedupeWindowMs) {
      record.delivery = 'fingerprint-suppressed';
      return this.addRecord(record);
    }

    if (urgency !== 'critical' && isWithinQuietHours(now, policy.quietHours)) {
      record.delivery = 'quiet-hours';
      return this.addRecord(record);
    }

    const lastDeliveredAt = this.kindLastDesktopDelivery.get(input.kind);
    if (urgency !== 'critical' && lastDeliveredAt !== undefined && now - lastDeliveredAt < policy.cooldownMs) {
      record.delivery = 'cooldown-suppressed';
      this.enqueueDigest(input.kind, policy.cooldownMs - (now - lastDeliveredAt));
      return this.addRecord(record);
    }

    record.delivery = this.showDesktop(input, urgency);
    if (record.delivery === 'desktop') this.kindLastDesktopDelivery.set(input.kind, now);
    return this.addRecord(record);
  }

  list(): readonly NotificationRecord[] {
    return this.records;
  }

  subscribe(listener: (record: NotificationRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private addRecord(record: NotificationRecord): NotificationRecord {
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // A stale renderer bridge must not break notification delivery or other subscribers.
      }
    }
    return record;
  }

  private getPolicy(): NotificationPolicy {
    const override = this.policyReader?.() ?? {};
    return {
      cooldownMs: Math.max(0, override.cooldownMs ?? this.cooldownMs),
      dedupeWindowMs: Math.max(0, override.dedupeWindowMs ?? this.dedupeWindowMs),
      quietHours: override.quietHours ?? this.quietHours,
    };
  }

  private pruneFingerprints(now: number, retentionMs: number): void {
    for (const [fingerprint, seenAt] of this.fingerprintLastSeen) {
      if (now - seenAt >= retentionMs) this.fingerprintLastSeen.delete(fingerprint);
    }
    while (this.fingerprintLastSeen.size > MAX_FINGERPRINTS) {
      const oldest = this.fingerprintLastSeen.keys().next().value;
      if (oldest === undefined) return;
      this.fingerprintLastSeen.delete(oldest);
    }
  }

  private showDesktop(input: Pick<NotificationInput, 'title' | 'body' | 'onClick'>, urgency: NotificationUrgency): NotificationDelivery {
    try {
      if (!this.desktop.isSupported()) return 'desktop-unavailable';
      this.desktop.show({ ...input, urgency });
      return 'desktop';
    } catch {
      return 'desktop-unavailable';
    }
  }

  private enqueueDigest(kind: string, delayMs: number): void {
    const pending = this.pendingDigests.get(kind);
    if (pending) {
      pending.count++;
      return;
    }

    const timeout = setTimeout(() => {
      const digest = this.pendingDigests.get(kind);
      this.pendingDigests.delete(kind);
      if (!digest) return;
      const now = this.now();
      const policy = this.getPolicy();
      if (isWithinQuietHours(now, policy.quietHours)) return;
      try {
        if (!this.desktop.isSupported()) return;
        this.desktop.show({ title: 'Agent finished', body: digestBody(kind, digest.count), urgency: 'normal' });
        this.kindLastDesktopDelivery.set(kind, now);
      } catch {
        // The in-app records already retain every event; desktop delivery is best effort.
      }
    }, delayMs);
    this.pendingDigests.set(kind, { count: 1, timeout });
  }

  dispose(): void {
    for (const digest of this.pendingDigests.values()) clearTimeout(digest.timeout);
    this.pendingDigests.clear();
    this.listeners.clear();
  }
}

let notificationServiceInstance: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  notificationServiceInstance ??= new NotificationService({
    policyReader: () => {
      const settings = getSettingsManager().getAll();
      return {
        cooldownMs: settings.notificationCooldownSeconds * 1000,
        quietHours: {
          enabled: settings.notificationQuietHoursEnabled,
          startHour: settings.notificationQuietHoursStartHour,
          endHour: settings.notificationQuietHoursEndHour,
        },
      };
    },
  });
  return notificationServiceInstance;
}

export function resetNotificationService(): void {
  notificationServiceInstance?.dispose();
  notificationServiceInstance = null;
}
