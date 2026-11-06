/**
 * Connects the instance manager's events to the receipt recorder, and carries
 * an orchestrator card's ending to the windows over the same event a CLI's
 * request uses, so a window has one place to learn that a card is gone.
 *
 * Kept out of `InstanceManager` because that file is at its size ceiling, and
 * because it can be tested here with plain event emitters.
 */

import type { EventEmitter } from 'events';
import type { SettledUserAction } from '../orchestration/user-action-lifecycle';
import { isRequestOutcomeReason, outcomeReasonForStatus, statusClearsOpenRequests } from '../../shared/utils/request-outcome';
import type { InputRequestReceiptRecorder, ObservedInputRequired } from './input-request-receipts';

/** What the binder needs from the orchestration handler. */
export interface ReceiptWiringOrchestration extends Pick<EventEmitter, 'on' | 'off'> {
  cancelUserActions(instanceId: string): number;
  endUserActions(instanceId: string, reason: 'cancelled' | 'exited'): number;
}

/** Returns a function that removes everything it added. */
export function bindInputRequestReceipts(
  manager: EventEmitter,
  recorder: InputRequestReceiptRecorder,
  orchestration: ReceiptWiringOrchestration,
): () => void {
  const listeners: [EventEmitter | ReceiptWiringOrchestration, string, (...args: unknown[]) => void][] = [];
  const on = <Args extends unknown[]>(
    source: EventEmitter | ReceiptWiringOrchestration,
    event: string,
    listener: (...args: Args) => void,
  ): void => {
    source.on(event, listener as (...args: unknown[]) => void);
    listeners.push([source, event, listener as (...args: unknown[]) => void]);
  };

  recorder.setLocalResolutionHandler((instanceId, requestId) => {
    manager.emit('instance:input-required-resolved', { instanceId, requestId, reason: 'decided' });
  });

  // A request from a CLI reached a window.
  on(manager, 'instance:input-required', (request: ObservedInputRequired) => recorder.observeInputRequired(request));

  // An adapter said a CLI's request ended without a reply from this window. Cards the model raised
  // announce themselves with `kind: 'user-action'` and are worded from their own event below.
  on(manager, 'instance:input-required-resolved', (event: { instanceId: string; requestId: string; reason: unknown; kind?: string }) => {
    if (event.kind === 'user-action' || !isRequestOutcomeReason(event.reason)) return;
    recorder.inputResolved({ instanceId: event.instanceId, requestId: event.requestId, reason: event.reason });
  });

  on(manager, 'instance:state-changed', (event: { instanceId: string; status: string }) => {
    recorder.statusChanged(event.instanceId, event.status);
    if (statusClearsOpenRequests(event.status)) {
      orchestration.endUserActions(event.instanceId, outcomeReasonForStatus(event.status) === 'cancelled' ? 'cancelled' : 'exited');
    }
  });
  on(manager, 'instance:removed', (instanceId: string) => recorder.forgetInstance(instanceId));
  on(manager, 'instance:yolo-toggled', (event: { instanceId: string; yoloMode?: boolean }) => {
    if (event.yoloMode === true) recorder.yoloEnabled(event.instanceId);
  });

  // Stopping a session cancels every request from its interrupted turn.
  on(manager, 'instance:interrupt-requested', (event: { instanceId: string }) => {
    orchestration.cancelUserActions(event.instanceId);
  });

  // A card the model raised ended: leave the line, then tell every window and the phone it is gone.
  on(orchestration, 'user-action-resolved', (settled: SettledUserAction) => {
    recorder.userActionSettled(settled);
    manager.emit('instance:input-required-resolved', {
      instanceId: settled.request.instanceId,
      requestId: settled.request.id,
      reason: settled.end.reason,
      kind: 'user-action',
    });
  });

  return () => {
    recorder.setLocalResolutionHandler(undefined);
    for (const [source, event, listener] of listeners) source.off(event, listener as (...args: unknown[]) => void);
    listeners.length = 0;
  };
}
