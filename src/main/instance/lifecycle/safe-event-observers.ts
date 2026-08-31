import type { EventEmitter } from 'node:events';
import { getLogger } from '../../logging/logger';

type ObserverErrorHandler = (eventName: string, error: unknown) => void;
const managerLogger = getLogger('InstanceManager');
const lifecycleLogger = getLogger('InstanceLifecycle');

/** Invoke every observer even when an optional listener throws. */
export function createSafeObserverEmitter(
  emitter: EventEmitter,
  onError: ObserverErrorHandler,
): (eventName: string, ...args: unknown[]) => void {
  return (eventName, ...args) => {
    for (const listener of emitter.rawListeners(eventName)) {
      try {
        Reflect.apply(listener, emitter, args);
      } catch (error) {
        onError(eventName, error);
      }
    }
  };
}

/** Standard observer isolation used by the public instance-manager event surface. */
export function createInstanceManagerObserverEmitter(
  emitter: EventEmitter,
): (eventName: string, ...args: unknown[]) => void {
  return createSafeObserverEmitter(emitter, (eventName, error) => {
    managerLogger.warn('Instance event observer failed', {
      eventName,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Publish creation to every observer while isolating optional listener failures. */
export function emitInstanceLifecycleCreatedObservers(
  emitter: EventEmitter,
  payload: Record<string, unknown>,
): void {
  createSafeObserverEmitter(emitter, (_eventName, error) => {
    lifecycleLogger.error(
      'Instance creation observer failed',
      error instanceof Error ? error : undefined,
      { instanceId: payload['id'] },
    );
  })('created', payload);
}

/** Resolve the conventional instance id carried by lifecycle event payloads. */
export function getLifecycleEventInstanceId(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  return String((payload as { instanceId?: unknown }).instanceId ?? '');
}
