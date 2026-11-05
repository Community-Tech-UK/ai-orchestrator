import type {
  BrowserActionClass,
  BrowserGatewayResult,
  BrowserPermissionGrant,
} from '@contracts/types/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserAutoApprovePredicate } from './browser-auto-approve';
import type { BrowserEscalationService } from './browser-escalation-store';
import type { BrowserExtensionTabStore } from './browser-extension-tab-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGrantStore } from './browser-grant-store';
import type { BrowserProfileStore } from './browser-profile-store';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';
import type { BrowserTargetRegistry } from './browser-target-registry';
import type { BrowserPageChallengeProbe } from './browser-page-challenge-probe';
import type { BrowserOneTimeCodeFillLedger } from './browser-one-time-code-submit';
import type { BrowserGatewayContext } from './browser-gateway-service-types';

/**
 * The request a guarded mutation is prepared for. The optional target fields
 * are the caller's own: they tell the sign-in code box check which fields a
 * browser.type / browser.fill_form writes to.
 */
export type BrowserGuardedMutationRequest = BrowserGatewayContext & {
  profileId: string;
  targetId: string;
  requestId?: string;
  selector?: string;
  uid?: string;
  fields?: ReadonlyArray<{ selector?: string; uid?: string }>;
};

export interface BrowserGatewayPreparedMutation {
  grant: BrowserPermissionGrant;
  actionClass: BrowserActionClass;
  origin: string;
  url: string;
  exactApprovalRequestId?: string;
}

export type BrowserGatewayMutationPreparation =
  | { result: BrowserGatewayResult<null> }
  | ({ result?: undefined } & BrowserGatewayPreparedMutation);

export interface BrowserGatewayActionGuardOptions {
  profileStore: Pick<BrowserProfileStore, 'getProfile'>;
  targetRegistry: Pick<BrowserTargetRegistry, 'listTargets'>;
  driver: Pick<PuppeteerBrowserDriver, 'refreshTarget' | 'inspectElement'>;
  extensionTabStore: Pick<BrowserExtensionTabStore, 'getTab'>;
  grantStore: Pick<BrowserGrantStore, 'listGrants' | 'createGrant' | 'consumeGrant'>;
  approvalStore: Pick<BrowserApprovalStore, 'createRequest' | 'getRequest' | 'listRequests' | 'resolveRequest'>;
  autoApproveRequests?: BrowserAutoApprovePredicate;
  escalations?: Pick<BrowserEscalationService, 'raise'>;
  /** Live CAPTCHA and sign-in code box evidence (browser-page-challenge-probe). */
  probePageChallenge?: BrowserPageChallengeProbe;
  /** One-time codes fill_credential typed; releases the click that submits one. */
  oneTimeCodeFills?: Pick<BrowserOneTimeCodeFillLedger, 'has' | 'consume'>;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  onGrantedMutation?: (info: {
    grant: BrowserPermissionGrant;
    actionClass: BrowserActionClass;
  }) => void;
}
