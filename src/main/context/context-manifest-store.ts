/**
 * Context manifest store (WS-C6) — per-instance history of which AIO-owned
 * context sources ("system-prompt blocks", see prompt-injection-contract.ts)
 * a session actually received, recorded at each safe reassembly boundary
 * (spawn, respawn/continuity-revival, restart-with-summary compaction).
 *
 * Observability-only: nothing here changes what is sent to any provider.
 * Authoritative ONLY for AIO-owned inputs — this module has no visibility
 * into a provider's own internal prompt cache or session state, so a
 * 'supplied' status means "AIO composed this block into the text it sent
 * to the adapter", never "the provider actually consumed or retained it".
 * There is deliberately no 'provider-confirmed' status — see
 * {@link ContextManifestEntryStatus}.
 *
 * Persistence choice: an in-memory, module-scoped registry keyed by
 * instanceId, the same pattern `respawn-circuit-breaker.ts` uses for other
 * ephemeral per-instance runtime state (see `getOrCreateCircuitBreaker`).
 * A durable session-continuity journal entry was considered and rejected:
 * this data answers "what did the CURRENTLY RUNNING session receive", which
 * is meaningless once the instance's process has ended — a fresh instance
 * (even one that revives the same conversation) gets a fresh manifest
 * history starting at epoch 0, so there is no cross-restart continuity
 * requirement to persist for. Like the circuit-breaker registry, entries are
 * not yet actively evicted on instance termination (`deleteContextManifest`
 * is exported for a future wiring pass, matching the circuit breaker's
 * known gap) — the bounded per-instance history keeps any single instance's
 * footprint small in the meantime.
 */

import { getLogger } from '../logging/logger';
import {
  SYSTEM_PROMPT_BLOCK_ORDER,
  type SystemPromptBlockKind,
  type SystemPromptBlockManifestEntry,
} from './prompt-injection-contract';

const logger = getLogger('ContextManifestStore');

/** Bounded per-instance epoch history depth. */
const MAX_HISTORY_PER_INSTANCE = 20;

/**
 * 'supplied' — AIO composed this block's content into the text handed to the
 *   adapter for this epoch.
 * 'skipped-empty' — this block kind was evaluated but produced no content
 *   (not applicable at this depth/config, a feature toggle was off, or the
 *   source genuinely had nothing to contribute). Indistinguishable from
 *   "never attempted" with the instrumentation available today.
 * 'unavailable' — an attempt to build this block's content failed or timed
 *   out; the block was requested but AIO could not supply it this epoch.
 *
 * There is intentionally no 'provider-confirmed' status: AIO can prove what
 * it sent, never what the provider's own process actually kept or used from
 * it. The UI must say so rather than imply provider-side confirmation.
 */
export type ContextManifestEntryStatus = 'supplied' | 'skipped-empty' | 'unavailable';

export interface ContextManifestEntry {
  kind: SystemPromptBlockKind;
  status: ContextManifestEntryStatus;
  /** sha256 hex digest of the block's content — only set when status is 'supplied'. */
  contentHash?: string;
  /** Character length of the block's content — only set when status is 'supplied'. */
  charLength?: number;
  /** 0-based position in the composed prompt text — only set when status is 'supplied'. */
  position?: number;
}

export type ContextManifestTrigger = 'spawn' | 'respawn' | 'restart-compact';

export interface ContextManifestSnapshot {
  /** Monotonically increasing per-instance counter, starting at 0. */
  epoch: number;
  at: number;
  trigger: ContextManifestTrigger;
  /** Every SYSTEM_PROMPT_BLOCK_ORDER kind, exactly once. */
  entries: ContextManifestEntry[];
  /**
   * Free-text honesty note for boundaries that don't fit the per-kind entry
   * model — e.g. a fresh restart that re-spawns the CLI with no AIO
   * system-prompt blocks re-injected at all (see restartFreshInstance in
   * instance-lifecycle.ts). Absent for ordinary spawn/respawn epochs.
   */
  note?: string;
}

/**
 * Build the full per-kind entry list (every SYSTEM_PROMPT_BLOCK_ORDER kind,
 * exactly once) from the composer's non-empty manifest plus the set of
 * kinds a caller observed a real failure/timeout for. Kinds present in
 * neither `manifest` nor `unavailableKinds` are 'skipped-empty'.
 */
export function buildContextManifestEntries(
  manifest: readonly SystemPromptBlockManifestEntry[],
  unavailableKinds: ReadonlySet<SystemPromptBlockKind> = new Set(),
): ContextManifestEntry[] {
  const suppliedByKind = new Map(manifest.map((entry) => [entry.kind, entry]));
  return SYSTEM_PROMPT_BLOCK_ORDER.map((kind): ContextManifestEntry => {
    const supplied = suppliedByKind.get(kind);
    if (supplied) {
      return {
        kind,
        status: 'supplied',
        contentHash: supplied.contentHash,
        charLength: supplied.charLength,
        position: supplied.position,
      };
    }
    return {
      kind,
      status: unavailableKinds.has(kind) ? 'unavailable' : 'skipped-empty',
    };
  });
}

interface InstanceManifestState {
  nextEpoch: number;
  history: ContextManifestSnapshot[];
}

const registry = new Map<string, InstanceManifestState>();

/**
 * Record a new epoch for `instanceId`, advancing its epoch counter. Returns
 * the recorded snapshot. `entries` must already be redaction-safe — block
 * kind + hash + length only, never raw content or filesystem paths (see the
 * module header and prompt-injection-contract.ts's abstract block kinds).
 */
export function recordContextManifest(
  instanceId: string,
  trigger: ContextManifestTrigger,
  entries: ContextManifestEntry[],
  options: { note?: string; now?: number } = {},
): ContextManifestSnapshot {
  let state = registry.get(instanceId);
  if (!state) {
    state = { nextEpoch: 0, history: [] };
    registry.set(instanceId, state);
  }
  const snapshot: ContextManifestSnapshot = {
    epoch: state.nextEpoch,
    at: options.now ?? Date.now(),
    trigger,
    entries,
    ...(options.note ? { note: options.note } : {}),
  };
  state.nextEpoch += 1;
  state.history.push(snapshot);
  if (state.history.length > MAX_HISTORY_PER_INSTANCE) {
    state.history.splice(0, state.history.length - MAX_HISTORY_PER_INSTANCE);
  }
  logger.debug('Recorded context manifest epoch', {
    instanceId,
    epoch: snapshot.epoch,
    trigger,
    suppliedCount: entries.filter((entry) => entry.status === 'supplied').length,
  });
  return snapshot;
}

/** Bounded epoch history for an instance, oldest first. Empty if none recorded. */
export function getContextManifestHistory(instanceId: string): ContextManifestSnapshot[] {
  return registry.get(instanceId)?.history ?? [];
}

export function getLatestContextManifest(instanceId: string): ContextManifestSnapshot | undefined {
  const history = registry.get(instanceId)?.history;
  return history && history.length > 0 ? history[history.length - 1] : undefined;
}

/** Drop all recorded history for an instance (e.g. on termination). Not yet wired — see module header. */
export function deleteContextManifest(instanceId: string): void {
  registry.delete(instanceId);
}

/** For tests only — reset the module-scoped registry to a clean slate. */
export function _resetAllContextManifestsForTesting(): void {
  registry.clear();
}
