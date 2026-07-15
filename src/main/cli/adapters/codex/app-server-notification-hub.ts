import type {
  AppServerNotification,
  AppServerNotificationHandler,
} from './app-server-types';

type NotificationObserverErrorHandler = (
  notification: AppServerNotification,
  error: unknown,
) => void;

/** Synchronous, wire-order fan-out for app-server notifications. */
export class AppServerNotificationHub {
  primary: AppServerNotificationHandler | null = null;
  private readonly subscribers = new Set<AppServerNotificationHandler>();

  constructor(private readonly onObserverError: NotificationObserverErrorHandler) {}

  subscribe(handler: AppServerNotificationHandler): () => void {
    this.subscribers.add(handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.subscribers.delete(handler);
    };
  }

  dispatch(notification: AppServerNotification): void {
    const handlers = [
      ...(this.primary ? [this.primary] : []),
      ...this.subscribers,
    ];
    for (const handler of handlers) {
      try {
        handler(notification);
      } catch (error) {
        this.onObserverError(notification, error);
      }
    }
  }
}
