/**
 * Worker↔main event forwarding for the "per-process singleton EventEmitter"
 * bug class (LT-169 skill controls, LT-170 skill activations, LT-206 RLM
 * context + wake context). Every affected singleton (`SkillAttributionService`,
 * `RLMContextManager`, `WakeContextBuilder`) is a `getInstance()`-style
 * per-process singleton. Production routes real RLM/skill/wake-context work
 * through the context-worker process, so that singleton's own instance emits
 * events an identically-named listener on main's separate instance can never
 * observe — Node's `EventEmitter` does not cross process boundaries.
 *
 * This module is the single place both sides of the fix live:
 * - `registerWorkerEventForwarding` (called once from `context-worker-main.ts`)
 *   subscribes to the allowlisted (singleton, event) pairs and posts each one
 *   across the existing worker↔main transport.
 * - `dispatchWorkerBroadcast` (called from `context-worker-client.ts`'s
 *   message handler) re-emits a received broadcast on main's own matching
 *   singleton, so `ipc-main-runtime-wiring.ts`'s existing forwarding
 *   subscriptions (registered on main's singletons) see it exactly as if it
 *   had been emitted in-process.
 *
 * Only add an event here once its payload is confirmed clone-safe (no
 * functions, no class instances the receiver needs methods on —
 * `structuredClone`/worker `postMessage` strips those). `RLMContextManager`
 * also emits `summarize:request`/`sub_query:request`, which carry callback
 * functions — those must NEVER be added here.
 */

import { getSkillAttribution, type SkillActivation } from '../skills/skill-attribution-service';
import { RLMContextManager } from '../rlm/context-manager';
import { getWakeContextBuilder } from '../memory/wake-context-builder';
import type { ContextWorkerOutboundMsg, WorkerForwardedEventMsg } from './context-worker-protocol';

interface ForwardTransport {
  postMessage(message: ContextWorkerOutboundMsg): void;
}

/** RLM events whose payloads are plain data (see rlm.types.ts) and safe to clone across. */
const RLM_FORWARDED_EVENTS = ['store:created', 'section:added', 'section:removed', 'query:executed'] as const;

/** Worker-side: subscribe every allowlisted singleton event and post it across `transport`. */
export function registerWorkerEventForwarding(transport: ForwardTransport): void {
  getSkillAttribution().on('activation', (activation: SkillActivation) => {
    transport.postMessage({ type: 'skill-activation', activation });
  });

  const rlm = RLMContextManager.getInstance();
  for (const event of RLM_FORWARDED_EVENTS) {
    rlm.on(event, (payload: unknown) => {
      transport.postMessage({ type: 'worker-event', source: 'rlm-context', event, payload });
    });
  }

  getWakeContextBuilder().on('wake:context-generated', (payload: unknown) => {
    transport.postMessage({
      type: 'worker-event',
      source: 'wake-context',
      event: 'wake:context-generated',
      payload,
    });
  });
}

/** Main-side: re-emit a received worker broadcast on main's own matching singleton. */
export function dispatchWorkerBroadcast(msg: ContextWorkerOutboundMsg): void {
  if (msg.type === 'skill-activation') {
    getSkillAttribution().emit('activation', msg.activation);
    return;
  }
  if (msg.type !== 'worker-event') return;
  const { source, event, payload } = msg as WorkerForwardedEventMsg;
  switch (source) {
    case 'rlm-context':
      RLMContextManager.getInstance().emit(event, payload);
      return;
    case 'wake-context':
      getWakeContextBuilder().emit(event, payload);
      return;
  }
}
