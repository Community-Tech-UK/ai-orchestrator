import { EventEmitter } from 'node:events';
import { getSkillAttribution } from '../skills/skill-attribution-service';
import { getWakeContextBuilder } from '../memory/wake-context-builder';
import type {
  ContextWorkerOutboundMsg,
  RlmWorkerEventMsg,
} from './context-worker-protocol';

export class ContextWorkerEventRelay extends EventEmitter {
  publish(message: RlmWorkerEventMsg): void {
    this.emit(message.event, message.payload);
  }
}

let relay: ContextWorkerEventRelay | null = null;

export function getContextWorkerEventRelay(): ContextWorkerEventRelay {
  relay ??= new ContextWorkerEventRelay();
  return relay;
}

export function publishRlmWorkerEvent(message: RlmWorkerEventMsg): void {
  getContextWorkerEventRelay().publish(message);
}

/** Main-side: publish typed RLM DTOs to the relay; preserve other broadcasts. */
export function dispatchWorkerBroadcast(message: ContextWorkerOutboundMsg): void {
  if (message.type === 'skill-activation') {
    getSkillAttribution().emit('activation', message.activation);
    return;
  }
  if (message.type !== 'worker-event') return;
  if (message.source === 'rlm-context') {
    publishRlmWorkerEvent(message);
    return;
  }
  getWakeContextBuilder().emit(message.event, message.payload);
}

export function _resetContextWorkerEventRelayForTesting(): void {
  relay?.removeAllListeners();
  relay = null;
}
