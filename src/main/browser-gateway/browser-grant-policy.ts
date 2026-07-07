import type {
  BrowserActionClass,
  BrowserPermissionGrant,
  BrowserProvider,
} from '@contracts/types/browser';
import { isOriginAllowed } from './browser-origin-policy';

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
 * Action classes that can NEVER be authorized by any grant, autonomous or not.
 * `payment` fields (card/CVV/IBAN/sort code) have no automated path — the
 * classifier hard-stops them and grantMatches refuses them outright, so even a
 * blanket autonomous campaign grant cannot fill a payment form.
 */
export function actionClassNeverGrantable(actionClass: BrowserActionClass): boolean {
  return actionClass === 'payment';
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

function grantMatches(
  grant: BrowserPermissionGrant,
  input: BrowserGrantMatchInput,
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
