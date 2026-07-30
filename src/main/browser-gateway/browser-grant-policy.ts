import type {
  BrowserActionClass,
  BrowserGrantMode,
  BrowserGrantProposal,
  BrowserPermissionGrant,
  BrowserProvider,
} from '@contracts/types/browser';
import { allowedOriginsCover, isOriginAllowed } from './browser-origin-policy';

export interface BrowserGrantMatchInput {
  grants: BrowserPermissionGrant[];
  instanceId: string;
  provider?: BrowserProvider;
  nodeId?: string;
  profileId: string;
  targetId?: string;
  origin: string;
  liveOrigin?: string;
  actionClass: BrowserActionClass;
  autonomousRequired?: boolean;
  now?: number;
}

export type BrowserGrantMatchResult =
  | {
      grant: BrowserPermissionGrant;
      reason?: never;
    }
  | {
      grant?: never;
      reason:
        | 'origin_changed_before_execution'
        | 'no_matching_grant';
    };

/**
 * Action classes that may only execute under a grant with `autonomous: true`
 * (see grantMatches below). Grants covering these classes must be created
 * with `autonomous: true` or they can never authorize the action they were
 * approved for.
 */
export function actionClassRequiresAutonomy(actionClass: BrowserActionClass): boolean {
  return actionClass === 'submit' || actionClass === 'destructive';
}

export function requiresAutonomousGrant(
  actionClasses: readonly BrowserActionClass[],
): boolean {
  return actionClasses.some(actionClassRequiresAutonomy);
}

/**
 * Action classes that can NEVER be authorized by an ordinary permission grant or
 * per-action approval, autonomous or not:
 *  - `payment` (card/CVV) has no automated path at all.
 *  - `financial_identity` / `sensitive_identity` (bank + tax/ID secrets) are
 *    fillable ONLY through the secret broker under a standing secret-fill
 *    authorization — never via a raw `browser.type` grant.
 * grantMatches refuses all three, so even a blanket autonomous campaign grant
 * cannot fill them through the ordinary path.
 */
export function actionClassNeverGrantable(actionClass: BrowserActionClass): boolean {
  return (
    actionClass === 'payment' ||
    actionClass === 'financial_identity' ||
    actionClass === 'sensitive_identity'
  );
}

export function findMatchingBrowserGrant(
  input: BrowserGrantMatchInput,
): BrowserGrantMatchResult {
  if (input.liveOrigin && input.liveOrigin !== input.origin) {
    return { reason: 'origin_changed_before_execution' };
  }

  const now = input.now ?? Date.now();
  const grant = input.grants.find((candidate) =>
    grantMatches(candidate, input, now),
  );
  return grant ? { grant } : { reason: 'no_matching_grant' };
}

export interface BrowserGrantProposalCoverageInput {
  grants: BrowserPermissionGrant[];
  instanceId: string;
  provider?: BrowserProvider;
  nodeId?: string;
  profileId: string;
  targetId?: string;
  /** Live origin of the target the proposal is about. */
  origin: string;
  proposal: BrowserGrantProposal;
  now?: number;
}

/**
 * Broadest-first ordering used to decide whether a live grant is at least as
 * permissive as a proposal's mode. `per_action` grants are consumed by the next
 * mutation, so they only stand in for another `per_action` request.
 */
const GRANT_MODE_RANK: Record<BrowserGrantMode, number> = {
  per_action: 0,
  session: 1,
  autonomous: 2,
};

/**
 * A live grant that already authorizes everything `proposal` asks for, or null.
 *
 * `browser.request_grant` uses this to answer "you already have this" instead of
 * recording another approval request. Agents re-request a grant whenever an
 * unrelated failure looks like a permission problem (an extension command
 * timeout, for example), and without this every re-request raised a fresh
 * approval dialog for the same site the user had just approved.
 */
export function findGrantCoveringProposal(
  input: BrowserGrantProposalCoverageInput,
): BrowserPermissionGrant | null {
  const { proposal } = input;
  if (proposal.allowedActionClasses.length === 0) {
    return null;
  }
  // Upload roots are approved per path set — never assume an existing grant
  // covers a newly proposed one.
  if (proposal.uploadRoots && proposal.uploadRoots.length > 0) {
    return null;
  }
  const now = input.now ?? Date.now();
  const requiresAutonomy =
    requiresAutonomousGrant(proposal.allowedActionClasses) ||
    (proposal.mode === 'autonomous' && proposal.autonomous);
  return (
    input.grants.find(
      (grant) =>
        GRANT_MODE_RANK[grant.mode] >= GRANT_MODE_RANK[proposal.mode] &&
        (!proposal.allowExternalNavigation || grant.allowExternalNavigation) &&
        allowedOriginsCover(grant.allowedOrigins, proposal.allowedOrigins) &&
        proposal.allowedActionClasses.every((actionClass) =>
          grantMatches(
            grant,
            {
              instanceId: input.instanceId,
              ...(input.provider ? { provider: input.provider } : {}),
              ...(input.nodeId ? { nodeId: input.nodeId } : {}),
              profileId: input.profileId,
              ...(input.targetId ? { targetId: input.targetId } : {}),
              origin: input.origin,
              actionClass,
              autonomousRequired: requiresAutonomy,
            },
            now,
          ),
        ),
    ) ?? null
  );
}

/**
 * True when approving `pending` would authorize everything `requested` asks for.
 *
 * Lets a repeat `browser.request_grant` attach to the approval request already
 * waiting on the user instead of stacking a second identical dialog beside it.
 */
export function proposalCoversProposal(
  pending: BrowserGrantProposal,
  requested: BrowserGrantProposal,
): boolean {
  if (requested.allowedActionClasses.length === 0) {
    return false;
  }
  if (GRANT_MODE_RANK[pending.mode] < GRANT_MODE_RANK[requested.mode]) {
    return false;
  }
  if (requested.autonomous && !pending.autonomous) {
    return false;
  }
  if (requested.allowExternalNavigation && !pending.allowExternalNavigation) {
    return false;
  }
  const pendingRoots = new Set(pending.uploadRoots ?? []);
  if (!(requested.uploadRoots ?? []).every((root) => pendingRoots.has(root))) {
    return false;
  }
  if (
    !requested.allowedActionClasses.every((actionClass) =>
      pending.allowedActionClasses.includes(actionClass),
    )
  ) {
    return false;
  }
  return allowedOriginsCover(pending.allowedOrigins, requested.allowedOrigins);
}

type BrowserGrantMatchCriteria = Pick<
  BrowserGrantMatchInput,
  | 'instanceId'
  | 'provider'
  | 'nodeId'
  | 'profileId'
  | 'targetId'
  | 'origin'
  | 'actionClass'
  | 'autonomousRequired'
>;

function grantMatches(
  grant: BrowserPermissionGrant,
  input: BrowserGrantMatchCriteria,
  now: number,
): boolean {
  if (actionClassNeverGrantable(input.actionClass)) {
    return false;
  }
  if (grant.decision !== 'allow') {
    return false;
  }
  if (grant.instanceId !== input.instanceId) {
    return false;
  }
  if (input.provider && grant.provider !== input.provider) {
    return false;
  }
  if (grant.profileId && grant.profileId !== input.profileId) {
    return false;
  }
  if (!grant.profileId && grant.nodeId && grant.nodeId !== input.nodeId) {
    return false;
  }
  if (grant.targetId && input.targetId && grant.targetId !== input.targetId) {
    return false;
  }
  if (grant.expiresAt <= now || grant.revokedAt || grant.consumedAt) {
    return false;
  }
  if (input.autonomousRequired && !grant.autonomous) {
    return false;
  }
  if (!grant.allowedActionClasses.includes(input.actionClass)) {
    return false;
  }
  return isOriginAllowed(input.origin, grant.allowedOrigins).allowed;
}
