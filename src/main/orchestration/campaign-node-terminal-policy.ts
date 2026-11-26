import type { LoopWorktreeLifecycle } from '../../shared/types/loop.types';
import type { CampaignNodeStatus, CampaignOnNodeNeedsReview } from './campaign.types';
import { campaignHeldBlockReason, campaignLandingBlockReason } from './campaign-worktree-landing';

/**
 * What should happen to a campaign when one of its node loops reaches a
 * terminal state. Pure: the coordinator applies the decision (pause, halt or
 * advance) and owns all persistence. Extracted from `campaign-coordinator.ts`
 * so the terminal policy stays readable and the coordinator stays inside its
 * size ceiling.
 */
export type CampaignNodeTerminalDecision =
  | { kind: 'advance' }
  | { kind: 'pause'; reason: string }
  | { kind: 'halt'; reason: string };

export function nodeTerminalDecision(input: {
  nodeId: string;
  nodeStatus: CampaignNodeStatus;
  onNodeNeedsReview: CampaignOnNodeNeedsReview;
  /** The step's work was held back on its branch instead of merged. */
  mergeHold: boolean;
  /** The node's label when it has one; the reason names the step by it. */
  label?: string;
  /** The node worktree's final lifecycle, for block/hold reporting. */
  landing?: LoopWorktreeLifecycle;
}): CampaignNodeTerminalDecision {
  const { nodeId, nodeStatus, onNodeNeedsReview, mergeHold, label, landing } = input;
  const landingBlock = nodeStatus === 'completed' || nodeStatus === 'completed-needs-review'
    ? campaignLandingBlockReason(nodeId, landing)
    : null;
  if (landingBlock && nodeStatus === 'completed-needs-review' && onNodeNeedsReview === 'halt') {
    return { kind: 'halt', reason: `Node ${nodeId} reached completed-needs-review (policy: halt); ${landingBlock}` };
  }
  if (landingBlock) {
    return { kind: 'pause', reason: landingBlock };
  }
  if (nodeStatus === 'completed-needs-review') {
    if (onNodeNeedsReview === 'pause-campaign') {
      return { kind: 'pause', reason: `Node ${nodeId} reached completed-needs-review` };
    }
    if (onNodeNeedsReview === 'halt') {
      return { kind: 'halt', reason: `Node ${nodeId} reached completed-needs-review (policy: halt)` };
    }
    // A held step (skipped checks; work kept on its branch) pauses even on
    // 'continue', so later steps cannot start without it.
    if (mergeHold) {
      return { kind: 'pause', reason: campaignHeldBlockReason(nodeId, label, landing?.sessionBranch) };
    }
  }
  if (nodeStatus === 'failed') {
    return { kind: 'pause', reason: `Node ${nodeId} failed; waiting for operator review` };
  }
  if (nodeStatus === 'operator-halted') {
    return { kind: 'halt', reason: `Node ${nodeId} was cancelled by the operator` };
  }
  return { kind: 'advance' };
}
