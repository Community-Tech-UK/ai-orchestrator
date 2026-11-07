import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { inputRequiredNotice } from './attention-notices';
import { getNotificationService, type NotificationService } from './notification-service';

interface InputRequired { instanceId: string; requestId: string; metadata?: Record<string, unknown> }

const WAITING_STATUSES = new Set(['waiting_for_input', 'waiting_for_permission']);

// Request ids are connection-local (ACP json-rpc ids), so two sessions can
// both have request "1"; every outstanding key and resolve key names the
// session so one session's resolution never touches another's notification.
const outstandingKey = (instanceId: string, requestId: string): string => `${instanceId}\u0000${requestId}`;
const inputResolveKey = (instanceId: string, requestId: string): string => `input:${instanceId}:${requestId}`;

/** Never forwards the raw prompt: permission prompts can contain commands and paths. */
export function registerInputRequiredNotifier(options: {
  instanceManager: Pick<InstanceManager, 'on' | 'removeListener' | 'getInstance'>;
  windowManager: Pick<WindowManager, 'isMainWindowFocused' | 'drawAttention'>;
  notifications?: NotificationService;
}): () => void {
  const { instanceManager, windowManager } = options;
  const notifications = options.notifications ?? getNotificationService();
  // Outstanding notifications this notifier created: (instanceId, requestId)
  // -> the resolveKey it was created with, plus the status seen when each
  // request was recorded (the same lifecycle fallback PendingRequestStore
  // uses — see its comment on the missing resolved event for ordinary
  // question answers).
  const outstanding = new Map<string, { instanceId: string; resolveKey: string }>();
  const lastStatus = new Map<string, string | undefined>();

  const resolveAllFor = (instanceId: string): void => {
    for (const [key, entry] of [...outstanding]) {
      if (entry.instanceId !== instanceId) continue;
      outstanding.delete(key);
      notifications.resolve(entry.resolveKey);
    }
    lastStatus.delete(instanceId);
  };

  const forgetResolved = (instanceId: string, requestId: string): void => {
    if (!outstanding.delete(outstandingKey(instanceId, requestId))) return;
    for (const entry of outstanding.values()) if (entry.instanceId === instanceId) return;
    lastStatus.delete(instanceId);
  };

  const required = (payload: InputRequired) => {
    const instance = instanceManager.getInstance(payload.instanceId);
    if (!instance || windowManager.isMainWindowFocused() || instance.yoloMode || instance.metadata?.['automationId']) return;
    lastStatus.set(payload.instanceId, instance.status as string | undefined);
    const resolveKey = inputResolveKey(payload.instanceId, payload.requestId);
    outstanding.set(outstandingKey(payload.instanceId, payload.requestId), { instanceId: payload.instanceId, resolveKey });
    try {
      notifications.notify({ kind: 'input-required', instanceId: payload.instanceId,
        ...inputRequiredNotice(instance.displayName, payload.metadata),
        fingerprintFields: { requestId: payload.requestId }, resolveKey,
        cooldownKey: `input-required:${payload.instanceId}` });
      windowManager.drawAttention();
    } catch { /* Desktop alerts must not interrupt provider event handling. */ }
  };
  const resolved = (payload: { instanceId: string; requestId: string }) => {
    forgetResolved(payload.instanceId, payload.requestId);
    notifications.resolve(inputResolveKey(payload.instanceId, payload.requestId));
  };
  // Ordinary AskUserQuestion answers emit no input-required-resolved event, so
  // a notification is also resolved when the turn completes past its prompt
  // (the instance leaves the waiting states) or its session is removed.
  const stateChanged = (event: { instanceId: string; status?: string }) => {
    if (!lastStatus.has(event.instanceId)) return;
    const previous = lastStatus.get(event.instanceId);
    lastStatus.set(event.instanceId, event.status as string | undefined);
    if (previous !== undefined && WAITING_STATUSES.has(previous) && !WAITING_STATUSES.has(event.status ?? '')) {
      resolveAllFor(event.instanceId);
    }
  };
  const removed = (instanceId: string) => resolveAllFor(instanceId);
  instanceManager.on('instance:input-required', required);
  instanceManager.on('instance:input-required-resolved', resolved);
  instanceManager.on('instance:state-changed', stateChanged);
  instanceManager.on('instance:removed', removed);
  return () => {
    instanceManager.removeListener('instance:input-required', required);
    instanceManager.removeListener('instance:input-required-resolved', resolved);
    instanceManager.removeListener('instance:state-changed', stateChanged);
    instanceManager.removeListener('instance:removed', removed);
  };
}
