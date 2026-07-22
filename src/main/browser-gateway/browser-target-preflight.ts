import type { BrowserTarget } from '@contracts/types/browser';

/**
 * Preflight target selection.
 *
 * Picking the tab to drive used to be implicit, and the failure mode was
 * expensive: an agent asking for the user's logged-in Mac tab could end up
 * driving a managed automation profile that is signed OUT (Google and Apple
 * block sign-in on automation browsers), or a tab on a different computer
 * entirely. This makes the choice explicit and, crucially, explains every
 * rejection so the caller can fix the real problem instead of guessing.
 *
 * The rule that must never be broken: a managed profile is never *silently*
 * substituted for the user's real session.
 */

export type BrowserTargetChannel =
  /** The AIO host's own Chrome, via the local extension — the user's real session. */
  | 'local-extension'
  /** A worker node's Chrome, via the extension relay — that user's real session. */
  | 'remote-extension'
  /** A Harness-launched automation profile. Separate cookies; usually signed out. */
  | 'managed-profile';

export interface BrowserTargetIdentity {
  channel: BrowserTargetChannel;
  /** 'local', or the node's name/id. Stable label for the `computer` argument. */
  computer: string;
  /** True when this target is the user's own logged-in browser session. */
  usesRealUserSession: boolean;
}

export type BrowserTargetRejectionReason =
  | 'different_computer'
  | 'different_origin'
  | 'not_available'
  | 'channel_stale'
  | 'managed_profile_is_not_the_user_session';

export interface BrowserTargetRejection extends BrowserTargetIdentity {
  targetId: string;
  url?: string;
  reason: BrowserTargetRejectionReason;
  explanation: string;
}

export interface BrowserTargetPreflightResult {
  selected: (BrowserTargetIdentity & {
    targetId: string;
    profileId?: string;
    url?: string;
    title?: string;
  }) | null;
  rejected: BrowserTargetRejection[];
  summary: string;
}

export interface BrowserTargetPreflightInput {
  url: string;
  targets: BrowserTarget[];
  /** Resolved computer scope; undefined means "any computer". */
  requestedComputer?: { nodeId?: string; localOnly: boolean };
}

export function identifyBrowserTarget(target: BrowserTarget): BrowserTargetIdentity {
  if (target.driver !== 'extension') {
    return {
      channel: 'managed-profile',
      computer: target.nodeName ?? target.nodeId ?? 'local',
      usesRealUserSession: false,
    };
  }
  return target.nodeId
    ? {
      channel: 'remote-extension',
      computer: target.nodeName ?? target.nodeId,
      usesRealUserSession: true,
    }
    : { channel: 'local-extension', computer: 'local', usesRealUserSession: true };
}

/**
 * Choose the best existing logged-in target for a URL, or nothing at all.
 *
 * Preference order: same-origin real session, then same-host real session.
 * A managed profile is only ever *reported*, never selected — the caller must
 * opt into it deliberately, because it is a different browser identity.
 */
export function selectBrowserTargetForUrl(
  input: BrowserTargetPreflightInput,
): BrowserTargetPreflightResult {
  const wanted = parseUrl(input.url);
  const rejected: BrowserTargetRejection[] = [];
  const candidates: Array<{ target: BrowserTarget; identity: BrowserTargetIdentity; rank: number }> = [];

  for (const target of input.targets) {
    const identity = identifyBrowserTarget(target);
    const reject = (
      reason: BrowserTargetRejectionReason,
      explanation: string,
    ): void => {
      rejected.push({
        ...identity,
        targetId: target.id,
        ...(target.url ? { url: target.url } : {}),
        reason,
        explanation,
      });
    };

    if (!matchesRequestedComputer(target, input.requestedComputer)) {
      reject(
        'different_computer',
        `Tab is on "${identity.computer}", which is not the requested computer.`,
      );
      continue;
    }
    if (target.status === 'closed' || target.status === 'error') {
      reject('not_available', `Tab status is "${target.status}".`);
      continue;
    }
    if (!identity.usesRealUserSession) {
      reject(
        'managed_profile_is_not_the_user_session',
        'This is a Harness-managed automation profile with its own cookie jar. It is '
        + 'usually signed out, and many providers block sign-in on automation browsers. '
        + 'Ask for it explicitly if you really want it.',
      );
      continue;
    }
    if (target.stale) {
      reject(
        'channel_stale',
        'The extension channel for this tab is stale, so the tab may no longer exist. '
        + 'Refresh the inventory (list_targets with refresh) before relying on it.',
      );
      continue;
    }

    const rank = originRank(target.url, wanted);
    if (rank === null) {
      reject('different_origin', `Tab is at a different site (${hostOf(target.url) ?? 'unknown'}).`);
      continue;
    }
    candidates.push({ target, identity, rank });
  }

  candidates.sort((a, b) => a.rank - b.rank || b.target.lastSeenAt - a.target.lastSeenAt);
  const best = candidates[0];
  if (!best) {
    return {
      selected: null,
      rejected,
      summary: describeNoSelection(rejected, input.url),
    };
  }
  return {
    selected: {
      ...best.identity,
      targetId: best.target.id,
      ...(best.target.profileId ? { profileId: best.target.profileId } : {}),
      ...(best.target.url ? { url: best.target.url } : {}),
      ...(best.target.title ? { title: best.target.title } : {}),
    },
    rejected,
    summary: `Selected a ${best.identity.channel} tab on "${best.identity.computer}"`
      + `${best.rank === 0 ? ' at the exact origin' : ' on the same site'}`
      + `; rejected ${rejected.length} other target(s).`,
  };
}

function matchesRequestedComputer(
  target: BrowserTarget,
  requested: BrowserTargetPreflightInput['requestedComputer'],
): boolean {
  if (!requested) {
    return true;
  }
  if (requested.localOnly) {
    return !target.nodeId;
  }
  return !requested.nodeId || target.nodeId === requested.nodeId;
}

/** 0 = same origin, 1 = same host, null = unrelated. */
function originRank(targetUrl: string | undefined, wanted: URL | null): number | null {
  const parsed = parseUrl(targetUrl);
  if (!wanted || !parsed) {
    return null;
  }
  if (parsed.origin === wanted.origin) {
    return 0;
  }
  return parsed.hostname === wanted.hostname ? 1 : null;
}

function describeNoSelection(rejected: BrowserTargetRejection[], url: string): string {
  if (rejected.length === 0) {
    return `No browser targets exist yet for ${url}. Ask the user to share the tab, `
      + 'or open one with find_or_open.';
  }
  const counts = new Map<BrowserTargetRejectionReason, number>();
  for (const entry of rejected) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .map(([reason, count]) => `${count}× ${reason}`)
    .join(', ');
  return `No suitable logged-in tab for ${url} (${breakdown}). See `
    + '`rejected` for the specific reason on each target.';
}

function parseUrl(value: string | undefined): URL | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostOf(value: string | undefined): string | null {
  return parseUrl(value)?.hostname ?? null;
}
