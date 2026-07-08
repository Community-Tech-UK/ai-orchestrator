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
import type { FillPlanStep } from './browser-fill-plan-executor';
import type { CredentialVault, CredentialFieldKind } from './browser-credential-vault';
import type { CredentialAuthorizationService } from './browser-credential-authorization-store';
import type { BrowserEmailCodeReader } from './browser-email-code-reader';

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
  computer?: string;
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
  computer?: string;
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

export interface BrowserGatewayExecuteFillPlanRequest extends BrowserGatewayContext {
  profileId: string;
  targetId: string;
  steps: FillPlanStep[];
  /** Apply+verify attempts per step before failing the plan (default 2). */
  maxAttempts?: number;
}

export interface BrowserGatewayFillCredentialField {
  /** CSS selector for the credential input. */
  selector: string;
  /**
   * Which secret to type: a vault field, or 'email_code' — a one-time
   * verification code read from the agent mailbox (sender-domain + recency
   * disambiguation) instead of the vault.
   */
  kind: CredentialFieldKind | 'email_code';
}

export interface BrowserGatewayFillCredentialEmailCodeOptions {
  /** Sender domains; each must relate to the live page origin (validated). */
  senderDomains?: string[];
  /** Only consider mail received at/after this time (default: now - withinMs). */
  sinceMs?: number;
  /** Recency window in ms (default 15 minutes). */
  withinMs?: number;
}

export interface BrowserGatewayFillCredentialRequest extends BrowserGatewayContext {
  profileId: string;
  targetId: string;
  /** Opaque vault item reference — NOT a secret. Resolved in-process. */
  vaultItemRef: string;
  fields: BrowserGatewayFillCredentialField[];
  /** Tuning for email_code fields only. */
  emailCode?: BrowserGatewayFillCredentialEmailCodeOptions;
}

export interface BrowserGatewayCreateAgentCredentialRequest extends BrowserGatewayContext {
  profileId: string;
  targetId: string;
  /** The username/email for the new account (e.g. james@communitytech.co.uk). */
  username: string;
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
    | 'readControl'
    | 'setChecked'
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
  /**
   * Agent credential vault (Bitwarden-backed). Optional: when absent,
   * browser.fill_credential is unavailable. Secrets resolved here never enter
   * model context.
   */
  credentialVault?: Pick<CredentialVault, 'getSecretForFill' | 'createAgentCredential'>;
  /** Standing James-granted authorizations gating browser.fill_credential. */
  credentialAuthorizations?: Pick<CredentialAuthorizationService, 'check'>;
  /**
   * Agent-mailbox one-time-code reader for email_code fields. Optional: when
   * absent, email_code fills are unavailable. Codes never enter model context.
   */
  emailCodeReader?: Pick<BrowserEmailCodeReader, 'fetchCode'>;
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
