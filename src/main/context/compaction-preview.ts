/**
 * Manual compaction preview (WS-B7).
 *
 * Read-only: never mutates instance/compactor/checkpoint state. Mirrors the
 * exact cut math the real restart-with-summary path uses (see
 * `compaction-boundary.ts`) so the preview and the real apply can never
 * disagree, and is honest about `adapter-self-managed` providers (Codex
 * app-server today) where AIO has no boundary control at all.
 */

import type { Instance } from '../../shared/types/instance.types';
import type { CompactionBoundaryOptions, CompactionPreview } from '../../shared/types/compaction-preview.types';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';
import type { InstanceManager } from '../instance/instance-manager';
import { ContextCompactor } from './context-compactor';
import {
  computeCompactionCut,
  exchangesToMessageBoundary,
  groupExchanges,
  messageBoundaryToExchangeCount,
  type CompactionTurnRole,
} from './compaction-boundary';
import { loadAuthenticatedEvidencePreviews } from './compaction-evidence-preview';

const EMPTY_RANGE = { fromIndex: 0, toIndex: -1, messageCount: 0 };

interface CompactionTurn extends CompactionTurnRole {
  content: string;
}

function extractTurns(instance: Instance): CompactionTurn[] {
  return instance.outputBuffer
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .map((message) => ({ role: message.type as 'user' | 'assistant', content: message.content }));
}

/** Builds a read-only preview of what manual compaction would do right now. */
export async function previewCompaction(
  instanceManager: InstanceManager,
  instanceId: string,
  opts?: CompactionBoundaryOptions,
): Promise<CompactionPreview> {
  const instance = instanceManager.getInstance(instanceId);
  if (!instance) {
    return {
      mode: 'unavailable',
      affectedRange: EMPTY_RANGE,
      keptVerbatimCount: 0,
      tokenEstimate: { value: 0, source: 'heuristic' },
      protectedItems: { mostRecentUserTurnProtected: false, authenticatedEvidencePreserved: false },
      totalMessageCount: 0,
      totalExchangeCount: 0,
      keepLatestExchanges: opts?.keepLatestExchanges ?? 0,
      note: 'This instance no longer exists.',
    };
  }

  const turns = extractTurns(instance);
  const exchanges = groupExchanges(turns);
  const capabilities = instanceManager.getAdapterRuntimeCapabilities(instanceId);

  if (capabilities?.supportsNativeCompaction) {
    return {
      mode: 'adapter-self-managed',
      affectedRange: EMPTY_RANGE,
      keptVerbatimCount: 0,
      tokenEstimate: {
        value: instance.contextUsage?.used ?? 0,
        // LT-018: `isEstimated !== true` was true for the create-time
        // placeholder (which sets neither field), so an instance that had never
        // reported occupancy was labelled `measured` and rendered as
        // "~0 (measured)" — a confident claim about a number nobody measured.
        // Only a genuine report earns `measured`.
        source: instance.contextUsage?.occupancyReported && instance.contextUsage.isEstimated !== true
          ? 'measured'
          : 'heuristic',
      },
      protectedItems: { mostRecentUserTurnProtected: false, authenticatedEvidencePreserved: false },
      totalMessageCount: turns.length,
      totalExchangeCount: exchanges.length,
      keepLatestExchanges: opts?.keepLatestExchanges ?? 0,
      note: "This provider manages context compaction internally. AIO cannot preview or bound what will be summarized — confirming runs the provider's own compaction as-is.",
    };
  }

  const defaultPreserveRecent = ContextCompactor.getInstance().getConfig().preserveRecent;
  const preserveRecentMessages = opts?.keepLatestExchanges === undefined
    ? Math.min(defaultPreserveRecent, turns.length)
    : exchangesToMessageBoundary(exchanges, opts.keepLatestExchanges);

  const cut = computeCompactionCut(turns, preserveRecentMessages);
  const tokenValue = cut.affectedIndices.reduce(
    (sum, index) => sum + sharedEstimateTokens(turns[index]!.content),
    0,
  );
  const evidencePreviews = await loadAuthenticatedEvidencePreviews(instance);

  return {
    mode: 'aio-managed',
    affectedRange: cut.affectedIndices.length === 0
      ? EMPTY_RANGE
      : {
          fromIndex: cut.affectedIndices[0]!,
          toIndex: cut.affectedIndices[cut.affectedIndices.length - 1]!,
          messageCount: cut.affectedIndices.length,
        },
    keptVerbatimCount: cut.keptIndices.length,
    tokenEstimate: { value: tokenValue, source: 'heuristic' },
    protectedItems: {
      mostRecentUserTurnProtected: cut.rescuedLastUserTurnIndex !== null,
      authenticatedEvidencePreserved: evidencePreviews.length > 0,
    },
    totalMessageCount: turns.length,
    totalExchangeCount: exchanges.length,
    keepLatestExchanges: opts?.keepLatestExchanges
      ?? messageBoundaryToExchangeCount(exchanges, preserveRecentMessages),
    note: null,
  };
}
