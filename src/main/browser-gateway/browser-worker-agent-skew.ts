import type { WorkerNodeExtensionRelaySummary, WorkerNodeInfo } from '../../shared/types/worker-node.types';

export const BROWSER_WORKER_AGENT_TOO_OLD = 'browser_worker_agent_too_old';
export const BROWSER_EXTENSION_RUNTIME_INCOMPATIBLE = 'browser_extension_runtime_incompatible';

/** Consecutive pre-delivery rejections before a live channel counts as incapable. */
export const PRE_DELIVERY_INCAPABLE_MIN = 3;

/**
 * Consecutive DELIVERED-but-unanswered commands before a polling channel counts
 * as unable to execute. Distinct from the pre-delivery counter above: these
 * commands were handed off successfully, so every delivery-side signal stays
 * green while nothing actually runs.
 */
export const POST_DELIVERY_UNANSWERED_MIN = 3;

/**
 * Whether a channel that ACCEPTS commands is also answering them. The two are
 * independent — an MV3 service worker can keep long-polling after the half that
 * executes commands has died — and conflating them is what let a node report
 * `commandsDeliverable: true` for 9 hours while every command timed out.
 */
export interface BrowserDeliveryHealth {
  /** False only once POST_DELIVERY_UNANSWERED_MIN consecutive commands timed out. */
  commandsAnswered: boolean;
  consecutiveUnanswered: number;
  lastUnansweredAt?: number;
  lastReason?: string;
}

export interface BrowserRuntimeEvidence {
  extensionVersion?: string;
  extensionStartedAt?: number;
}

export interface BrowserPreDeliveryCapability {
  commandsDeliverable: boolean;
  reason?: string;
}

export function workerAgentTooOldReason(nodeName: string): string {
  return `${BROWSER_WORKER_AGENT_TOO_OLD}: the worker agent on ${nodeName} is too old `
    + `to forward extension runtime evidence; redeploy the worker agent to ${nodeName}`;
}

export function hasBrowserRuntimeEvidence(runtime: BrowserRuntimeEvidence | undefined): boolean {
  return Boolean(runtime?.extensionVersion) && runtime?.extensionStartedAt !== undefined;
}

export function nodeHasExtensionRelay(
  node: Pick<WorkerNodeInfo, 'capabilities'> | undefined,
): boolean {
  return Boolean(
    node?.capabilities.hasExtensionRelay
    || node?.capabilities.extensionRelay?.enabled,
  );
}

/**
 * Infer build skew from the heartbeat summary alone. The primary signal is a
 * live `extensionVersion` on a relay that does not declare
 * `forwardsRuntimeEvidence` — that is the pre-e29b41ba worker, and it cannot
 * be asked to declare anything.
 */
export function isInferredWorkerAgentSkew(
  relay: WorkerNodeExtensionRelaySummary | undefined,
  hasExtensionRelay: boolean,
): boolean {
  if (relay?.forwardsRuntimeEvidence === true) {
    return false;
  }
  if (!hasExtensionRelay && relay?.enabled !== true) {
    return false;
  }
  return Boolean(relay?.extensionVersion);
}

export function describeInferredWorkerAgentSkew(
  node: WorkerNodeInfo | undefined,
): string {
  if (!node) {
    return '';
  }
  return isInferredWorkerAgentSkew(
    node.capabilities.extensionRelay,
    nodeHasExtensionRelay(node),
  )
    ? workerAgentTooOldReason(node.name)
    : '';
}

/**
 * Classify a fail-closed extension contact. Missing top-level evidence on a
 * node whose relay is talking (or predates the contract marker) is worker
 * skew, not a Chrome-runtime problem.
 */
export function classifyBrowserExtensionIncompatibility(input: {
  runtime: BrowserRuntimeEvidence;
  nodeName: string;
  hasExtensionRelay: boolean;
  relay?: WorkerNodeExtensionRelaySummary;
}): { kind: 'skew' | 'runtime'; reason: string } {
  if (hasBrowserRuntimeEvidence(input.runtime)) {
    return {
      kind: 'runtime',
      reason: BROWSER_EXTENSION_RUNTIME_INCOMPATIBLE,
    };
  }
  if (
    input.hasExtensionRelay
    && input.relay?.forwardsRuntimeEvidence !== true
  ) {
    return {
      kind: 'skew',
      reason: workerAgentTooOldReason(input.nodeName),
    };
  }
  if (input.relay?.extensionVersion && input.relay.forwardsRuntimeEvidence !== true) {
    return {
      kind: 'skew',
      reason: workerAgentTooOldReason(input.nodeName),
    };
  }
  return {
    kind: 'runtime',
    reason: BROWSER_EXTENSION_RUNTIME_INCOMPATIBLE,
  };
}

export function assessRemoteExtensionCommandCapability(input: {
  nodeName: string;
  hasExtensionRelay: boolean;
  relay?: WorkerNodeExtensionRelaySummary;
  preDelivery?: BrowserPreDeliveryCapability;
}): BrowserPreDeliveryCapability {
  if (isInferredWorkerAgentSkew(input.relay, input.hasExtensionRelay)) {
    return {
      commandsDeliverable: false,
      reason: workerAgentTooOldReason(input.nodeName),
    };
  }
  if (input.preDelivery && !input.preDelivery.commandsDeliverable) {
    return {
      commandsDeliverable: false,
      ...(input.preDelivery.reason ? { reason: input.preDelivery.reason } : {}),
    };
  }
  return { commandsDeliverable: true };
}
