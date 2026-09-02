/**
 * Worker↔main event forwarding for the "per-process singleton EventEmitter"
 * bug class (LT-169 skill controls, LT-170 skill activations, LT-206 RLM
 * context + wake context). Production routes real RLM/skill/wake-context work
 * through worker processes, and Node's `EventEmitter` does not cross process
 * boundaries. RLM events therefore need an explicit DTO hop to main's relay;
 * skill and wake events retain their existing main-singleton dispatch.
 *
 * This worker-only module subscribes to the allowlisted event sources and
 * posts normalized DTOs across the existing worker↔main transport. Main-side
 * dispatch lives in `context-worker-event-relay.ts`, keeping this module free
 * of a carried RLM manager dependency when the client imports dispatch.
 *
 * `RLMContextManager` also emits `summarize:request`/`sub_query:request`, which
 * carry callback functions — those must NEVER be added here.
 */

import { getSkillAttribution, type SkillActivation } from '../skills/skill-attribution-service';
import { getWakeContextBuilder } from '../memory/wake-context-builder';
import {
  isHighVolumeContextStore,
  serializeContextQueryResultForIpc,
  serializeContextSectionForIpc,
  serializeContextStoreForIpc,
} from '../ipc/rlm-ipc-serialization';
import type {
  ContextQueryResult,
  ContextSection,
  ContextStore,
  RLMSession,
} from '../../shared/types/rlm.types';
import type {
  ContextWorkerOutboundMsg,
  RlmWorkerEventMsg,
} from './context-worker-protocol';
import type { RlmContextQueryResultDto } from './rlm-worker-port';

interface ForwardTransport {
  postMessage(message: ContextWorkerOutboundMsg): void;
}

interface RlmWorkerEventSource {
  on(event: (typeof RLM_FORWARDED_EVENTS)[number], listener: (payload: unknown) => void): unknown;
}

/** RLM events whose payloads are plain data (see rlm.types.ts) and safe to clone across. */
const RLM_FORWARDED_EVENTS = ['store:created', 'section:added', 'section:removed', 'query:executed'] as const;

export const RLM_EVENT_STORE_SECTION_LIMIT = 500;
export const RLM_EVENT_QUERY_RESULT_MAX_CHARS = 100_000;
export const RLM_EVENT_ACCESSED_SECTION_IDS_LIMIT = 500;
export const RLM_EVENT_SUB_QUERY_NODE_LIMIT = 20;

function serializeQueryResultForWorker(result: ContextQueryResult): RlmContextQueryResultDto {
  let remainingSubQueryNodes = RLM_EVENT_SUB_QUERY_NODE_LIMIT;
  let remainingResultChars = RLM_EVENT_QUERY_RESULT_MAX_CHARS;
  let remainingAccessedSectionIds = RLM_EVENT_ACCESSED_SECTION_IDS_LIMIT;
  const visit = (value: ContextQueryResult): RlmContextQueryResultDto => {
    const resultText = value.result.slice(0, remainingResultChars);
    remainingResultChars -= resultText.length;
    const sectionsAccessed = value.sectionsAccessed.slice(
      0,
      remainingAccessedSectionIds,
    );
    remainingAccessedSectionIds -= sectionsAccessed.length;
    const serialized = serializeContextQueryResultForIpc({
      ...value,
      result: resultText,
      sectionsAccessed,
      subQueries: undefined,
    });
    const subQueries: RlmContextQueryResultDto[] = [];
    for (const subQuery of value.subQueries ?? []) {
      if (remainingSubQueryNodes === 0) break;
      remainingSubQueryNodes--;
      subQueries.push(visit(subQuery));
    }
    return value.subQueries === undefined ? serialized : { ...serialized, subQueries };
  };
  return visit(result);
}

function serializeRlmWorkerEvent(
  event: (typeof RLM_FORWARDED_EVENTS)[number],
  payload: unknown,
): RlmWorkerEventMsg {
  switch (event) {
    case 'store:created': {
      const store = payload as ContextStore;
      return {
        type: 'worker-event',
        source: 'rlm-context',
        event,
        payload: serializeContextStoreForIpc(store),
      };
    }
    case 'section:added': {
      const { store, section } = payload as { store: ContextStore; section: ContextSection };
      return {
        type: 'worker-event',
        source: 'rlm-context',
        event,
        payload: {
          storeId: store.id,
          section: serializeContextSectionForIpc(section),
          highVolume: isHighVolumeContextStore(store),
          store: serializeContextStoreForIpc(store, {
            includeSections: true,
            sectionLimit: RLM_EVENT_STORE_SECTION_LIMIT,
          }),
        },
      };
    }
    case 'section:removed': {
      const { store, section } = payload as { store: ContextStore; section: ContextSection };
      return {
        type: 'worker-event',
        source: 'rlm-context',
        event,
        payload: {
          storeId: store.id,
          sectionId: section.id,
          highVolume: isHighVolumeContextStore(store),
          store: serializeContextStoreForIpc(store, {
            includeSections: true,
            sectionLimit: RLM_EVENT_STORE_SECTION_LIMIT,
          }),
        },
      };
    }
    case 'query:executed': {
      const { session, queryResult } = payload as {
        session: RLMSession;
        queryResult: ContextQueryResult;
      };
      return {
        type: 'worker-event',
        source: 'rlm-context',
        event,
        payload: {
          sessionId: session.id,
          queryResult: serializeQueryResultForWorker(queryResult),
        },
      };
    }
  }
}

/** Worker-side: subscribe every allowlisted singleton event and post it across `transport`. */
export function registerWorkerEventForwarding(
  transport: ForwardTransport,
  rlm: RlmWorkerEventSource,
): void {
  getSkillAttribution().on('activation', (activation: SkillActivation) => {
    transport.postMessage({ type: 'skill-activation', activation });
  });

  for (const event of RLM_FORWARDED_EVENTS) {
    rlm.on(event, (payload: unknown) => {
      transport.postMessage(serializeRlmWorkerEvent(event, payload));
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
