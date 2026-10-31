import type { AppServerNotification } from './app-server-types';

/** Retains wire order and prevents queued events reaching a predecessor's subscriber. */
export class PendingCodexTurnNotifications {
  private readonly notifications: AppServerNotification[] = [];
  private deferred = new WeakSet<AppServerNotification>();

  get length(): number { return this.notifications.length; }
  has(notification: AppServerNotification): boolean { return this.deferred.has(notification); }
  release(notification: AppServerNotification): void { this.deferred.delete(notification); }

  push(notification: AppServerNotification): void {
    this.notifications.push(notification);
    this.deferred.add(notification);
  }

  /** The first event was validated as a root turn/started before enqueueing. */
  takeTurn(): AppServerNotification[] {
    const first = this.notifications[0];
    const turnId = notificationTurnId(first);
    const next = this.notifications.findIndex((event, index) => index > 0
      && event.method === 'turn/started' && event.params['threadId'] === first.params['threadId']
      && notificationTurnId(event) !== turnId);
    return this.notifications.splice(0, next < 0 ? this.notifications.length : next);
  }

  clear(): void {
    this.notifications.length = 0;
    this.deferred = new WeakSet<AppServerNotification>();
  }
}

export function notificationTurnId(notification: AppServerNotification): unknown {
  return notification.params['turnId'] ?? (notification.params['turn'] as { id?: unknown } | undefined)?.id;
}
