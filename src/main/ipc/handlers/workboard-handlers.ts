/**
 * WS-C1 Workboard decision timeline IPC handler.
 *
 * Purely a read-time assembler: every field comes from a store that already
 * persists it (or, for compaction, an in-memory per-instance tracker that
 * lives for the process session). No new persistence, no event subscription
 * state, no second policy engine — see
 * `src/main/workboard/operational-decision-projection.ts` for the mapping.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  WorkboardDecisionsForItemPayloadSchema,
  type OperationalDecision,
} from '@contracts/schemas/workboard';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getLoopStore } from '../../orchestration/loop-store';
import { isParkedLoopRuntimeState } from '../../orchestration/loop-runtime-status';
import { ProviderLimitLedger } from '../../core/system/provider-limit-ledger';
import { getCompactionCoordinator } from '../../context/compaction-coordinator';
import { getAutomationStore } from '../../automations';
import { SessionAdmissionStore } from '../../session/session-admission-store';
import { getRLMDatabase } from '../../persistence/rlm-database';
import {
  buildAdmissionDecisions,
  buildAutomationDecisions,
  buildCompactionDecisions,
  buildLoopGateDecisions,
  buildProviderLimitDecisions,
  mergeOperationalDecisions,
} from '../../workboard/operational-decision-projection';
import { getLogger } from '../../logging/logger';
import type { ProviderId } from '../../../shared/types/provider-quota.types';

const logger = getLogger('WorkboardHandlers');

export interface RegisterWorkboardHandlersDeps {
  instanceManager: InstanceManager;
}

export function registerWorkboardHandlers(deps: RegisterWorkboardHandlersDeps): void {
  const { instanceManager } = deps;

  ipcMain.handle(
    IPC_CHANNELS.WORKBOARD_DECISIONS_FOR_ITEM,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse<OperationalDecision[]>> => {
      try {
        const validated = validateIpcPayload(
          WorkboardDecisionsForItemPayloadSchema,
          payload,
          'WORKBOARD_DECISIONS_FOR_ITEM',
        );
        const data = assembleDecisions(validated, instanceManager);
        return { success: true, data };
      } catch (error) {
        logger.warn('Failed to assemble Workboard decision timeline', {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          error: {
            code: 'WORKBOARD_DECISIONS_FOR_ITEM_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}

function assembleDecisions(
  query: { loopRunId?: string; automationRunId?: string; instanceId?: string },
  instanceManager: InstanceManager,
): OperationalDecision[] {
  const groups: OperationalDecision[][] = [];

  const loopStore = getLoopStore();
  const loopSummary = query.loopRunId ? loopStore.getRunSummary(query.loopRunId) : null;
  const instance = query.instanceId ? instanceManager.getInstance(query.instanceId) : undefined;

  // Source 1: provider-limit — resolve a provider from whichever id is live,
  // then match the durable ledger's events for this item by instanceId
  // (the ledger stores either a loop run id or a plain instance id there).
  const provider = resolveProvider(query, loopStore, instance?.provider);
  if (provider) {
    const ledger = ProviderLimitLedger.getInstance();
    const events = ledger
      .list({ provider })
      .filter((event) => event.instanceId === query.instanceId || event.instanceId === query.loopRunId);
    const active = ledger.getActive({ provider, model: null });
    const loopResumable = loopSummary !== null && isParkedLoopRuntimeState(loopSummary);
    groups.push(buildProviderLimitDecisions(events, {
      activeEventId: active?.id ?? null,
      loopRunId: query.loopRunId,
      loopResumable,
    }));
  }

  // Source 2: loop-gate — durable terminal intents + the run's final outcome.
  if (query.loopRunId) {
    const intents = loopStore.listTerminalIntents(query.loopRunId);
    groups.push(buildLoopGateDecisions(intents, loopSummary));
  }

  // Source 3: compaction — per-instance in-memory epoch history.
  if (query.instanceId) {
    const history = getCompactionCoordinator().getEpochTracker(query.instanceId).getHistory();
    groups.push(buildCompactionDecisions(history, query.instanceId));
  }

  // Source 4: automation — the run's own retry/failure state.
  if (query.automationRunId) {
    const run = getAutomationStore().getRun(query.automationRunId);
    groups.push(buildAutomationDecisions(run));
  }

  // Source 5: admission (WS-A1) — suppressed/expired/cancelled/failed sends.
  if (query.instanceId) {
    const admissionStore = SessionAdmissionStore.getInstance(getRLMDatabase().getRawDb());
    const records = admissionStore.list({
      instanceId: query.instanceId,
      states: ['suppressed', 'expired', 'cancelled', 'failed'],
      limit: 10,
    });
    groups.push(buildAdmissionDecisions(records));
  }

  return mergeOperationalDecisions(groups);
}

function resolveProvider(
  query: { loopRunId?: string; instanceId?: string },
  loopStore: ReturnType<typeof getLoopStore>,
  instanceProvider: string | undefined,
): ProviderId | null {
  if (instanceProvider && isProviderId(instanceProvider)) return instanceProvider;
  if (query.loopRunId) {
    const config = loopStore.getRunConfig(query.loopRunId);
    if (config && isProviderId(config.provider)) return config.provider;
  }
  return null;
}

const PROVIDER_IDS: ReadonlySet<string> = new Set<ProviderId>([
  'claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok',
]);

function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.has(value);
}
