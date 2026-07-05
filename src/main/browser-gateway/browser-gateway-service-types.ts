import type {
  BrowserAttachExistingTabRequest,
  BrowserCreateProfileRequest,
  BrowserListAuditLogRequest,
  BrowserScreenshotRequest,
  BrowserUpdateProfileRequest,
} from '@contracts/types/browser';
import type { BrowserAuditStore } from './browser-audit-store';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserAutoApprovePredicate } from './browser-auto-approve';
import type { BrowserExtensionCommandStore } from './browser-extension-command-store';
import type { BrowserExtensionTabStore } from './browser-extension-tab-store';
import type { BrowserGrantStore } from './browser-grant-store';
import type { BrowserHealthService } from './browser-health-service';
import type { BrowserExtensionContactStateReader } from './browser-extension-contact-state';
import type { BrowserProfileRegistry } from './browser-profile-registry';
import type { BrowserProfileStore } from './browser-profile-store';
import type { BrowserTargetRegistry } from './browser-target-registry';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';

export interface BrowserGatewayContext {
  instanceId?: string;
  provider?: string;
}

export interface BrowserGatewayNavigateRequest extends BrowserGatewayContext {
  profileId: string;
  targetId: string;
  url: string;
}

export interface BrowserGatewayTargetRequest extends BrowserGatewayContext {
  profileId: string;
  targetId: string;
}

export interface BrowserGatewayScreenshotRequest
  extends BrowserGatewayContext,
    BrowserScreenshotRequest {}

export interface BrowserGatewayListTargetsRequest extends BrowserGatewayContext {
  profileId?: string;
  nodeId?: string;
  refresh?: boolean;
}

export interface BrowserGatewayAuditLogRequest
  extends BrowserGatewayContext,
    BrowserListAuditLogRequest {}

export interface BrowserGatewayCreateProfileRequest
  extends BrowserGatewayContext,
    BrowserCreateProfileRequest {}

export interface BrowserGatewayFindOrOpenRequest extends BrowserGatewayContext {
  url?: string;
  titleHint?: string;
  nodeId?: string;
}

export interface BrowserGatewayAttachExistingTabRequest
  extends BrowserGatewayContext,
    BrowserAttachExistingTabRequest {
  nodeId?: string;
  nodeName?: string;
}

export interface BrowserGatewayUpdateProfileRequest
  extends BrowserGatewayContext,
    BrowserUpdateProfileRequest {
  profileId: string;
}

export interface BrowserGatewayMutatingActionRequest extends BrowserGatewayContext {
  toolName: string;
  action: string;
  profileId?: string;
  targetId?: string;
}

export interface BrowserGatewayServiceOptions {
  profileStore?: Pick<
    BrowserProfileStore,
    'listProfiles' | 'getProfile' | 'updateProfile' | 'deleteProfile' | 'setRuntimeState'
  >;
  profileRegistry?: Pick<BrowserProfileRegistry, 'createProfile' | 'resolveProfileDir'>;
  targetRegistry?: Pick<BrowserTargetRegistry, 'listTargets' | 'selectTarget'>;
  driver?: Pick<
    PuppeteerBrowserDriver,
    | 'openProfile'
    | 'closeProfile'
    | 'listTargets'
    | 'refreshTarget'
    | 'navigate'
    | 'snapshot'
    | 'accessibilitySnapshot'
    | 'evaluate'
    | 'screenshot'
    | 'consoleMessages'
    | 'networkRequests'
    | 'waitFor'
    | 'queryElements'
    | 'inspectElement'
    | 'click'
    | 'type'
    | 'fillForm'
    | 'select'
    | 'uploadFile'
    | 'downloadFile'
  >;
  extensionTabStore?: Pick<
    BrowserExtensionTabStore,
    'attachTab' | 'getTab' | 'detachTab' | 'listTabs'
  >;
  extensionCommandStore?: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
  extensionContactState?: BrowserExtensionContactStateReader;
  auditStore?: Pick<BrowserAuditStore, 'record' | 'list'>;
  grantStore?: Pick<BrowserGrantStore, 'listGrants' | 'consumeGrant' | 'createGrant' | 'revokeGrant'>;
  approvalStore?: Pick<BrowserApprovalStore, 'createRequest' | 'getRequest' | 'listRequests' | 'resolveRequest'>;
  healthService?: Pick<BrowserHealthService, 'diagnose'>;
  autoApproveRequests?: BrowserAutoApprovePredicate;
  /**
   * Resolve a pinned CDP debug port for a profile launch, or undefined to use a
   * random free port. Wired at the app root to consult chrome-devtools attach
   * settings; left undefined in tests (no pinning).
   */
  resolvePreferredDebugPort?: (profileId: string) => number | undefined;
  /**
   * Copy a coordinator-local file onto a remote worker node before an
   * existing-tab upload there, returning the node-local path to hand to the
   * extension. Defaults to the FileTransferService-backed implementation;
   * injectable for tests.
   */
  stageUploadFileOnNode?: (nodeId: string, localPath: string) => Promise<string>;
}
