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
