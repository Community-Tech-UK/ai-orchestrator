/**
 * Campaign spec validation and edge-predicate evaluation. Pure functions,
 * split out of `campaign-coordinator.ts` (which re-exports them) to keep that
 * file under the TS max-LOC cap.
 */

import type {
  CampaignNodeStatus,
  CampaignSpec,
  TerminalStatusPredicate,
} from './campaign.types';

const CAMPAIGN_PREDICATE_STATUSES = new Set<string>([
  'completed',
  'completed-needs-review',
  'failed',
  'operator-halted',
]);

/** Evaluate a TerminalStatusPredicate against a CampaignNodeStatus. Exported for unit testing. */
export function evaluatePredicate(status: CampaignNodeStatus, predicate: TerminalStatusPredicate): boolean {
  switch (predicate.type) {
    case 'is': return status === predicate.status;
    case 'in': return (predicate.statuses as string[]).includes(status);
    case 'not': return status !== predicate.status;
  }
}

export interface CampaignValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a CampaignSpec: check IDs are unique, edges reference existing nodes, graph is acyclic. */
export function validateCampaignSpec(spec: CampaignSpec): CampaignValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set<string>();

  if (!spec.nodes.length) errors.push('Campaign must have at least one node');
  if (!Number.isInteger(spec.policy.maxParallel) || spec.policy.maxParallel < 1 || spec.policy.maxParallel > 16) {
    errors.push('Campaign policy maxParallel must be an integer from 1 to 16');
  }
  if (!['pause-campaign', 'continue', 'halt'].includes(spec.policy.onNodeNeedsReview)) {
    errors.push('Campaign policy onNodeNeedsReview is invalid');
  }

  for (const node of spec.nodes) {
    if (!node.id) errors.push('Every node must have an id');
    if (nodeIds.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }

  for (const edge of spec.edges) {
    if (!nodeIds.has(edge.from)) errors.push(`Edge references unknown source node: ${edge.from}`);
    if (!nodeIds.has(edge.to)) errors.push(`Edge references unknown target node: ${edge.to}`);
    if (edge.from === edge.to) errors.push(`Self-loop on node: ${edge.from}`);
    if (edge.when) validateEdgePredicate(edge.from, edge.to, edge.when, errors);
  }

  if (errors.length === 0 && hasCycle(spec)) {
    errors.push('Campaign DAG contains a cycle');
  }

  return { valid: errors.length === 0, errors };
}

function validateEdgePredicate(
  from: string,
  to: string,
  predicate: TerminalStatusPredicate,
  errors: string[],
): void {
  if (predicate.type === 'in') {
    if (predicate.statuses.length === 0) {
      errors.push(`Edge ${from}->${to} predicate must include at least one status`);
      return;
    }
    for (const status of predicate.statuses) {
      if (!CAMPAIGN_PREDICATE_STATUSES.has(status)) {
        errors.push(`Edge ${from}->${to} predicate status is invalid: ${status}`);
      }
    }
    return;
  }

  if (!CAMPAIGN_PREDICATE_STATUSES.has(predicate.status)) {
    errors.push(`Edge ${from}->${to} predicate status is invalid: ${predicate.status}`);
  }
}

function hasCycle(spec: CampaignSpec): boolean {
  const adj = new Map<string, string[]>();
  for (const node of spec.nodes) adj.set(node.id, []);
  for (const edge of spec.edges) adj.get(edge.from)!.push(edge.to);

  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const node of spec.nodes) color.set(node.id, WHITE);

  function dfs(id: string): boolean {
    color.set(id, GREY);
    for (const neighbor of adj.get(id) ?? []) {
      if (color.get(neighbor) === GREY) return true;
      if (color.get(neighbor) === WHITE && dfs(neighbor)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const node of spec.nodes) {
    if (color.get(node.id) === WHITE && dfs(node.id)) return true;
  }
  return false;
}
