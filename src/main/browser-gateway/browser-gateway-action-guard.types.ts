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
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  onGrantedMutation?: (info: {
    grant: BrowserPermissionGrant;
    actionClass: BrowserActionClass;
  }) => void;
}
