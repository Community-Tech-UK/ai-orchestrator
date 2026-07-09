import type {
  BrowserActionClass,
  BrowserAllowedOrigin,
  BrowserPermissionGrant,
} from '@contracts/types/browser';
import type {
  BrowserCampaign,
  BrowserCampaignActionKind,
  BrowserCampaignService,
} from './browser-campaign-store';
import type { BrowserGrantStore } from './browser-grant-store';
import { providerFromContext } from './browser-gateway-action-guard';
import { existingTabGrantNodeId } from './browser-grant-scope';
import { isOriginAllowed } from './browser-origin-policy';
import { getLogger } from '../logging/logger';

/**
 * Runtime glue between the human-approved campaign envelope and the short-lived
 * grants that actually authorize actions:
 *
 *  - Child grants are linked to their campaign via `requestedBy:
 *    'campaign:<id>'` — the campaign is the standing authority; each grant is a
 *    short (~60 min) lease inside it. The 24h grant cap is never raised.
 *  - Every granted mutation executed under a campaign lease is counted against
 *    the campaign budget (`recordAction`); a submit counts as submit + action.
 *    When a budget trips, the campaign pauses and ALL of its live child grants
 *    are revoked, so the very next action stops.
 *  - `claimLease` lets an agent working an active, in-budget campaign obtain
 *    its lease without a fresh human approval (the human approved the campaign
 *    envelope once). `renewLeases` re-issues expiring leases while the
 *    campaign stays healthy.
 */

const logger = getLogger('BrowserCampaignRuntime');

export const CAMPAIGN_GRANT_REQUESTED_BY_PREFIX = 'campaign:';

/** Lease length for campaign child grants. */
export const CAMPAIGN_LEASE_MS = 60 * 60 * 1000;
/** Re-issue window: renew a lease when it has less than this long left. */
export const CAMPAIGN_LEASE_RENEW_WINDOW_MS = 10 * 60 * 1000;

export function campaignIdFromGrant(
  grant: Pick<BrowserPermissionGrant, 'requestedBy'>,
): string | null {
  return grant.requestedBy.startsWith(CAMPAIGN_GRANT_REQUESTED_BY_PREFIX)
    ? grant.requestedBy.slice(CAMPAIGN_GRANT_REQUESTED_BY_PREFIX.length)
    : null;
}

/**
 * Parse a campaign origin string ('https://portal.example.gov.uk' or
 * '*.example.gov.uk') into a grant origin pattern. Bare hosts default to https.
 */
export function campaignOriginToGrantOrigin(origin: string): BrowserAllowedOrigin | null {
  const raw = origin.trim();
  if (!raw) {
    return null;
  }
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme.replace('//*.', '//'));
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== 'https' && scheme !== 'http') {
    return null;
  }
  const wildcard = withScheme.includes('//*.');
  return {
    scheme,
    hostPattern: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    includeSubdomains: wildcard,
  };
}

export interface ClaimCampaignLeaseInput {
  campaignId: string;
  instanceId: string;
  provider?: string;
}

export type ClaimCampaignLeaseResult =
  | { granted: true; grant: BrowserPermissionGrant; renewed: boolean }
  | { granted: false; reason: string };

export interface RecordCampaignActionInput {
  profileId: string;
  instanceId?: string;
  provider?: string;
  url?: string;
}

export interface BrowserCampaignRuntimeOptions {
  campaigns: Pick<
    BrowserCampaignService,
    'get' | 'list' | 'recordAction' | 'canProceed' | 'getCounters'
  >;
  grantStore: Pick<BrowserGrantStore, 'listGrants' | 'createGrant' | 'revokeGrant'>;
  now?: () => number;
}

export class BrowserCampaignRuntime {
  private readonly campaigns: BrowserCampaignRuntimeOptions['campaigns'];
  private readonly grantStore: BrowserCampaignRuntimeOptions['grantStore'];
  private readonly now: () => number;

  constructor(options: BrowserCampaignRuntimeOptions) {
    this.campaigns = options.campaigns;
    this.grantStore = options.grantStore;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Budget enforcement hook, called for every successfully executed guarded
   * mutation. No-op unless the grant is a campaign lease. On a tripped budget
   * the campaign pauses (inside recordAction) and its child grants are revoked
   * so nothing else runs under the stale authority.
   */
  recordGrantedMutation(info: {
    grant: Pick<BrowserPermissionGrant, 'requestedBy'>;
    actionClass: BrowserActionClass;
  }): void {
    const campaignId = campaignIdFromGrant(info.grant);
    if (!campaignId) {
      return;
    }
    const kind: BrowserCampaignActionKind =
      info.actionClass === 'submit'
        ? 'submit'
        : info.actionClass === 'file-upload'
          ? 'upload'
          : 'action';
    this.recordCampaignAction(campaignId, kind);
  }

  /**
   * `browser.create_agent_credential` is intentionally not a normal guarded
   * browser mutation: it creates a vaulted account after standing credential
   * authorization, and no secret enters model context. Still, campaign
   * `maxNewAccounts` is load-bearing for unattended signup pilots, so a
   * successful creation must tick the matching live campaign lease.
   */
  recordNewAccount(input: RecordCampaignActionInput): void {
    this.recordCampaignActionForInstance(input, 'newAccount');
  }

  /** Count successful `browser.navigate` calls under a matching campaign lease. */
  recordNavigation(input: RecordCampaignActionInput): void {
    this.recordCampaignActionForInstance(input, 'action', 'navigate');
  }

  private recordCampaignActionForInstance(
    input: RecordCampaignActionInput,
    kind: BrowserCampaignActionKind,
    requiredActionClass?: BrowserActionClass,
  ): void {
    if (!input.instanceId) {
      return;
    }
    const nodeId = existingTabGrantNodeId(input.profileId);
    const provider = providerFromContext(input.provider);
    const grant = this.grantStore
      .listGrants({
        instanceId: input.instanceId,
        ...(nodeId ? { nodeId, profileId: input.profileId } : { profileId: input.profileId }),
      })
      .find(
        (candidate) =>
          candidate.provider === provider &&
          campaignIdFromGrant(candidate) !== null &&
          (!requiredActionClass || candidate.allowedActionClasses.includes(requiredActionClass)) &&
          (!input.url || isOriginAllowed(input.url, candidate.allowedOrigins).allowed),
      );
    const campaignId = grant ? campaignIdFromGrant(grant) : null;
    if (!campaignId) {
      return;
    }
    this.recordCampaignAction(campaignId, kind);
  }

  private recordCampaignAction(
    campaignId: string,
    kind: BrowserCampaignActionKind,
  ): void {
    try {
      const result = this.campaigns.recordAction(campaignId, kind);
      if (result.paused) {
        const revoked = this.revokeChildGrants(
          campaignId,
          result.reason ?? 'campaign_budget_exhausted',
        );
        logger.warn('Campaign budget tripped; campaign paused and leases revoked', {
          campaignId,
          revokedGrants: revoked,
          reason: result.reason,
        });
      }
    } catch (error) {
      // Enforcement must never crash the mutation path; an unknown campaign id
      // means the campaign row was deleted out from under a live grant.
      logger.warn('Failed to record campaign action', {
        campaignId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Issue (or renew) this instance's lease under an active, in-budget
   * campaign. The human approved the campaign once; leases inside it are
   * mechanical. Never raises the 24h grant cap — leases are ~60 min and capped
   * at the campaign's own expiry.
   */
  claimLease(input: ClaimCampaignLeaseInput): ClaimCampaignLeaseResult {
    const campaign = this.campaigns.get(input.campaignId);
    if (!campaign) {
      return { granted: false, reason: 'campaign_not_found' };
    }
    const now = this.now();
    const proceed = this.campaigns.canProceed(campaign.id, now);
    if (!proceed.ok) {
      return { granted: false, reason: proceed.reason ?? 'campaign_not_active' };
    }

    const existing = this.liveChildGrants(campaign).find(
      (grant) => grant.instanceId === input.instanceId,
    );
    if (existing && existing.expiresAt - now > CAMPAIGN_LEASE_RENEW_WINDOW_MS) {
      return { granted: true, grant: existing, renewed: false };
    }

    const grant = this.issueLease(campaign, input.instanceId, input.provider, now);
    if (!grant) {
      return { granted: false, reason: 'campaign_origins_invalid' };
    }
    return { granted: true, grant, renewed: existing !== undefined };
  }

  /**
   * Timer tick: re-issue leases expiring within the renew window for every
   * instance still holding one, while the campaign is active + within budget.
   * A paused/killed/expired campaign gets its remaining leases revoked instead.
   */
  renewLeases(): void {
    const now = this.now();
    for (const campaign of this.campaigns.list()) {
      const live = this.liveChildGrants(campaign);
      if (live.length === 0) {
        continue;
      }
      const proceed = (() => {
        try {
          return this.campaigns.canProceed(campaign.id, now);
        } catch {
          return { ok: false as const, reason: 'campaign_missing' };
        }
      })();
      if (!proceed.ok) {
        if (campaign.status !== 'active' || campaign.expiresAt <= now) {
          this.revokeChildGrants(campaign.id, proceed.reason ?? 'campaign_not_active');
        }
        continue;
      }
      const seenInstances = new Set<string>();
      for (const grant of live) {
        if (seenInstances.has(grant.instanceId)) {
          continue; // Newest lease per instance wins (list is newest-first).
        }
        seenInstances.add(grant.instanceId);
        if (grant.expiresAt - now <= CAMPAIGN_LEASE_RENEW_WINDOW_MS) {
          this.issueLease(campaign, grant.instanceId, grant.provider, now);
          logger.info('Renewed campaign lease', {
            campaignId: campaign.id,
            instanceId: grant.instanceId,
          });
        }
      }
    }
  }

  /** Revoke every live child grant of a campaign. Returns the revoked count. */
  revokeChildGrants(campaignId: string, reason: string): number {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) {
      return 0;
    }
    let revoked = 0;
    for (const grant of this.liveChildGrants(campaign)) {
      this.grantStore.revokeGrant(grant.id, reason);
      revoked += 1;
    }
    return revoked;
  }

  /** Campaign state hook: any transition away from 'active' kills the leases. */
  handleCampaignStateChange(campaign: BrowserCampaign): void {
    if (campaign.status !== 'active') {
      const revoked = this.revokeChildGrants(campaign.id, `campaign_${campaign.status}`);
      if (revoked > 0) {
        logger.info('Campaign left active state; leases revoked', {
          campaignId: campaign.id,
          status: campaign.status,
          revokedGrants: revoked,
        });
      }
    }
  }

  private liveChildGrants(campaign: BrowserCampaign): BrowserPermissionGrant[] {
    return this.grantStore
      .listGrants(campaignGrantListFilter(campaign))
      .filter((grant) => campaignIdFromGrant(grant) === campaign.id);
  }

  private issueLease(
    campaign: BrowserCampaign,
    instanceId: string,
    provider: string | undefined,
    now: number,
  ): BrowserPermissionGrant | null {
    const allowedOrigins = campaign.allowedOrigins
      .map(campaignOriginToGrantOrigin)
      .filter((origin): origin is BrowserAllowedOrigin => origin !== null);
    if (allowedOrigins.length === 0) {
      return null;
    }
    return this.grantStore.createGrant({
      mode: 'autonomous',
      instanceId,
      provider: providerFromContext(provider),
      ...campaignGrantScope(campaign),
      allowedOrigins,
      allowedActionClasses: campaign.allowedActionClasses as BrowserActionClass[],
      allowExternalNavigation: false,
      autonomous: true,
      requestedBy: `${CAMPAIGN_GRANT_REQUESTED_BY_PREFIX}${campaign.id}`,
      decidedBy: 'user',
      decision: 'allow',
      reason: `campaign lease: ${campaign.label}`,
      expiresAt: Math.min(now + CAMPAIGN_LEASE_MS, campaign.expiresAt),
    });
  }
}

function campaignGrantScope(
  campaign: BrowserCampaign,
): Pick<BrowserPermissionGrant, 'nodeId' | 'profileId'> {
  const nodeId = existingTabGrantNodeId(campaign.profileId);
  return nodeId ? { nodeId } : { profileId: campaign.profileId };
}

function campaignGrantListFilter(
  campaign: BrowserCampaign,
): { nodeId?: string; profileId?: string } {
  return campaignGrantScope(campaign);
}

let runtime: BrowserCampaignRuntime | null = null;
let renewTimer: NodeJS.Timeout | null = null;

export function initializeBrowserCampaignRuntime(
  options: BrowserCampaignRuntimeOptions & { renewIntervalMs?: number },
): BrowserCampaignRuntime {
  runtime = new BrowserCampaignRuntime(options);
  if (renewTimer) {
    clearInterval(renewTimer);
  }
  renewTimer = setInterval(() => runtime?.renewLeases(), options.renewIntervalMs ?? 60_000);
  renewTimer.unref?.();
  return runtime;
}

export function getBrowserCampaignRuntime(): BrowserCampaignRuntime | null {
  return runtime;
}

export function stopBrowserCampaignRuntime(): void {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
  runtime = null;
}
