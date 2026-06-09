export type BrowserActionClass =
  | 'read'
  | 'navigate'
  | 'input'
  | 'credential'
  | 'file-upload'
  | 'file-download'
  | 'submit'
  | 'destructive'
  | 'unknown';

export type BrowserProfileMode = 'session' | 'isolated';
export type BrowserProfileBrowser = 'chrome';
export type BrowserProfileStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'locked'
  | 'error';
export type BrowserTargetMode = BrowserProfileMode | 'existing-tab';
export type BrowserTargetDriver =
  | 'chrome-devtools-mcp'
  | 'cdp'
  | 'playwright'
  | 'extension';
export type BrowserTargetStatus =
  | 'available'
  | 'selected'
  | 'busy'
  | 'closed'
  | 'error';
export type BrowserGatewayDecision = 'allowed' | 'denied' | 'requires_user';
export type BrowserGatewayOutcome = 'not_run' | 'succeeded' | 'failed';
export type BrowserGrantMode = 'per_action' | 'session' | 'autonomous';
export type BrowserApprovalRequestStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired';
export type BrowserManualStepKind =
  | 'manual_review'
  | 'login'
  | 'captcha'
  | 'two_factor';
export type BrowserProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'copilot'
  | 'cursor'
  | 'orchestrator';

export interface BrowserAllowedOrigin {
  scheme: 'https' | 'http';
  hostPattern: string;
  port?: number;
  includeSubdomains: boolean;
}

export interface BrowserProfile {
  id: string;
  label: string;
  mode: BrowserProfileMode;
  browser: BrowserProfileBrowser;
  userDataDir?: string;
  allowedOrigins: BrowserAllowedOrigin[];
  defaultUrl?: string;
  /**
   * When set, this profile runs on a remote worker node: the gateway drives that
   * node's Chrome over the CDP tunnel (Path 2) instead of launching Chrome
   * locally. All governance (approval/grant/audit) still runs on the coordinator.
   */
  executionNodeId?: string;
  status: BrowserProfileStatus;
  debugPort?: number;
  debugEndpoint?: string;
  processId?: number;
  createdAt: number;
  updatedAt: number;
  lastLaunchedAt?: number;
  lastUsedAt?: number;
  lastLoginCheckAt?: number;
}

export interface BrowserTarget {
  id: string;
  profileId?: string;
  pageId?: string;
  driverTargetId?: string;
  mode: BrowserTargetMode;
  title?: string;
  url?: string;
  origin?: string;
  driver: BrowserTargetDriver;
  status: BrowserTargetStatus;
  lastSeenAt: number;
}

export interface BrowserPermissionGrant {
  id: string;
  mode: BrowserGrantMode;
  instanceId: string;
  provider: BrowserProvider;
  profileId?: string;
  targetId?: string;
  allowedOrigins: BrowserAllowedOrigin[];
  allowedActionClasses: BrowserActionClass[];
  allowExternalNavigation: boolean;
  uploadRoots?: string[];
  autonomous: boolean;
  requestedBy: string;
  decidedBy: 'user' | 'timeout' | 'revoked';
  decision: 'allow' | 'deny';
  reason?: string;
  expiresAt: number;
  createdAt: number;
  revokedAt?: number;
  consumedAt?: number;
}

export interface BrowserElementContext {
  role?: string;
  accessibleName?: string;
  visibleText?: string;
  inputType?: string;
  inputName?: string;
  placeholder?: string;
  label?: string;
  formAction?: string;
  attributes?: Record<string, string>;
  nearbyText?: string;
}

export interface BrowserGrantProposal {
  mode: BrowserGrantMode;
  allowedOrigins: BrowserAllowedOrigin[];
  allowedActionClasses: BrowserActionClass[];
  allowExternalNavigation: boolean;
  uploadRoots?: string[];
  autonomous: boolean;
}

export interface BrowserApprovalRequest {
  id: string;
  requestId: string;
  instanceId: string;
  provider: BrowserProvider;
  profileId: string;
  targetId?: string;
  toolName: string;
  action: string;
  actionClass: BrowserActionClass;
  origin?: string;
  url?: string;
  selector?: string;
  elementContext?: BrowserElementContext;
  filePath?: string;
  detectedFileType?: string;
  proposedGrant: BrowserGrantProposal;
  status: BrowserApprovalRequestStatus;
  grantId?: string;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
}

export interface BrowserAuditEntry {
  id: string;
  instanceId?: string;
  provider: string;
  profileId?: string;
  targetId?: string;
  action: string;
  toolName: string;
  actionClass: BrowserActionClass;
  origin?: string;
  url?: string;
  decision: BrowserGatewayDecision;
  outcome: BrowserGatewayOutcome;
  summary: string;
  redactionApplied: boolean;
  screenshotArtifactId?: string;
  requestId?: string;
  grantId?: string;
  autonomous?: boolean;
  createdAt: number;
}

export type BrowserGatewayResult<T = unknown> =
  | {
      decision: 'allowed';
      outcome: 'succeeded' | 'failed';
      data?: T;
      reason?: string;
      requestId?: never;
      auditId: string;
    }
  | {
      decision: 'denied';
      outcome: 'not_run';
      data?: T;
      reason?: string;
      requestId?: never;
      auditId: string;
    }
  | {
      decision: 'requires_user';
      outcome: 'not_run';
      data?: T;
      reason?: string;
      requestId: string;
      auditId: string;
    };

export interface BrowserCreateProfileRequest {
  label: string;
  mode: BrowserProfileMode;
  browser: BrowserProfileBrowser;
  allowedOrigins: BrowserAllowedOrigin[];
  defaultUrl?: string;
}

export interface BrowserAttachExistingTabRequest {
  tabId: number;
  windowId: number;
  url: string;
  title?: string;
  text?: string;
  screenshotBase64?: string;
  capturedAt?: number;
  allowedOrigins?: BrowserAllowedOrigin[];
  extensionOrigin?: string;
}

export interface BrowserDetachExistingTabRequest {
  profileId: string;
  targetId: string;
}

export interface BrowserUpdateProfileRequest {
  label?: string;
  allowedOrigins?: BrowserAllowedOrigin[];
  defaultUrl?: string | null;
  executionNodeId?: string | null;
}

export interface BrowserUpdateProfilePayload extends BrowserUpdateProfileRequest {
  profileId: string;
}

export interface BrowserProfileRequest {
  profileId: string;
}

export interface BrowserListTargetsRequest {
  profileId?: string;
}

export interface BrowserFindOrOpenRequest {
  url?: string;
  titleHint?: string;
}

export interface BrowserTargetRequest {
  profileId: string;
  targetId: string;
}

export interface BrowserNavigateRequest extends BrowserTargetRequest {
  url: string;
}

export interface BrowserScreenshotRequest extends BrowserTargetRequest {
  maxWidth?: number;
  maxHeight?: number;
  fullPage?: boolean;
}

export interface BrowserWaitForRequest extends BrowserTargetRequest {
  selector?: string;
  timeoutMs?: number;
}

export interface BrowserQueryElementsRequest extends BrowserTargetRequest {
  query?: string;
  limit?: number;
}

export interface BrowserSelectOption {
  value: string;
  label: string;
  selected: boolean;
}

export interface BrowserElementCandidate {
  selector: string;
  tagName: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  inputType?: string;
  placeholder?: string;
  href?: string;
  /** Current value of an input/textarea/select (password values are omitted). */
  value?: string;
  /** Visible label of the currently selected option(s) for a <select>. */
  selectedOption?: string;
  /** Checked state for checkbox/radio inputs and aria-checked controls. */
  checked?: boolean;
  /** Whether the control is disabled. */
  disabled?: boolean;
  /** aria-expanded state for comboboxes/disclosure controls. */
  expanded?: boolean;
  /** Available options for a native <select>. */
  options?: BrowserSelectOption[];
}

export interface BrowserClickRequest extends BrowserTargetRequest {
  /** CSS selector. Optional when `uid` is provided. */
  selector?: string;
  /** Robust CDP element handle from browser.accessibility_snapshot (pierces closed shadow roots). */
  uid?: string;
  actionHint?: string;
  requestId?: string;
}

export interface BrowserTypeRequest extends BrowserTargetRequest {
  /** CSS selector. Optional when `uid` is provided. */
  selector?: string;
  /** Robust CDP element handle from browser.accessibility_snapshot (pierces closed shadow roots). */
  uid?: string;
  value: string;
  actionHint?: string;
  requestId?: string;
}

export interface BrowserFillFormField {
  /** CSS selector. Optional when `uid` is provided. */
  selector?: string;
  /** Robust CDP element handle from browser.accessibility_snapshot (pierces closed shadow roots). */
  uid?: string;
  value: string;
  actionHint?: string;
}

export interface BrowserFillFormRequest extends BrowserTargetRequest {
  fields: BrowserFillFormField[];
  requestId?: string;
}

export interface BrowserSelectRequest extends BrowserTargetRequest {
  /** CSS selector. Optional when `uid` is provided. */
  selector?: string;
  /** Robust CDP element handle from browser.accessibility_snapshot (pierces closed shadow roots). */
  uid?: string;
  value: string;
  actionHint?: string;
  requestId?: string;
}

export interface BrowserAccessibilitySnapshotRequest extends BrowserTargetRequest {
  interestingOnly?: boolean;
  limit?: number;
}

export interface BrowserAccessibilityNode {
  /** Stringified backendDOMNodeId; pass as `uid` to click/type/select/fill_form. */
  uid: string;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  focused?: boolean;
  level?: number;
}

export interface BrowserEvaluateRequest extends BrowserTargetRequest {
  expression: string;
  awaitPromise?: boolean;
  actionHint?: string;
  requestId?: string;
}

export interface BrowserEvaluateResult {
  /** JSON-serialized return value (length-capped and redacted). */
  json?: string;
  type?: string;
  truncated?: boolean;
}

export interface BrowserUploadFileRequest extends BrowserTargetRequest {
  selector: string;
  filePath: string;
  actionHint?: string;
  requestId?: string;
}

export interface BrowserDownloadFileRequest extends BrowserTargetRequest {
  selector?: string;
  url?: string;
  suggestedFilename?: string;
  timeoutMs?: number;
  actionHint?: string;
  requestId?: string;
}

export interface BrowserDownloadFileResult {
  id?: number | string;
  url?: string;
  finalUrl?: string;
  filename?: string;
  mime?: string;
  bytesReceived?: number;
  totalBytes?: number;
  state?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface BrowserRequestUserLoginRequest extends BrowserProfileRequest {
  targetId?: string;
  reason?: string;
}

export interface BrowserManualStepRequest extends BrowserProfileRequest {
  targetId?: string;
  kind?: BrowserManualStepKind;
  reason?: string;
}

export interface BrowserApprovalStatusRequest {
  requestId: string;
}

export interface BrowserApprovalRequestLookup {
  requestId: string;
}

export interface BrowserApproveRequestPayload {
  requestId: string;
  grant: BrowserGrantProposal;
  reason?: string;
}

export interface BrowserDenyRequestPayload {
  requestId: string;
  reason?: string;
}

export interface BrowserCreateGrantRequest extends BrowserGrantProposal {
  instanceId: string;
  provider: BrowserProvider;
  profileId?: string;
  targetId?: string;
  requestedBy: string;
  expiresAt: number;
  reason?: string;
}

export interface BrowserListGrantsRequest {
  instanceId?: string;
  profileId?: string;
  includeExpired?: boolean;
  limit?: number;
}

export interface BrowserRevokeGrantRequest {
  grantId: string;
  reason?: string;
}

export interface BrowserListApprovalRequestsRequest {
  instanceId?: string;
  status?: BrowserApprovalRequestStatus;
  limit?: number;
}

export interface BrowserRequestGrantRequest extends BrowserTargetRequest {
  proposedGrant: BrowserGrantProposal;
  reason?: string;
}

export interface BrowserListAuditLogRequest {
  profileId?: string;
  instanceId?: string;
  limit?: number;
}
