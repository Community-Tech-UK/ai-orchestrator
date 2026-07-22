export type DesktopCapabilityState =
  | 'available'
  | 'missing_permission'
  | 'unavailable'
  | 'unsupported';

/**
 * The macOS system permissions Harness can request/register on the operator's
 * behalf. A closed enum: the renderer can never supply an arbitrary permission
 * or URL through this seam.
 */
export type DesktopSystemPermission = 'screen-recording' | 'accessibility';

/**
 * Result of a user-initiated native permission request performed by the
 * process that owns the protected capability (Electron for Screen Recording,
 * the bundled Swift helper for Accessibility).
 */
export interface DesktopPermissionRequestResult {
  permission: DesktopSystemPermission;
  /** Capability state re-read after the native request (or current state when no request ran). */
  state: DesktopCapabilityState;
  /** True when a real native request/registration was attempted this call. */
  nativeRequestAttempted: boolean;
}

/**
 * The renderer-facing action result: the driver request result plus whether a
 * System Settings pane (exact pane or Privacy & Security root) was opened.
 */
export interface DesktopPermissionActionResult extends DesktopPermissionRequestResult {
  settingsOpened: boolean;
}

/** Result of clearing only Harness's Computer Use TCC registrations. */
export interface DesktopPermissionRepairResult {
  resetPermissions: ['screen-recording', 'accessibility'];
  relaunchRequired: true;
}

export interface DesktopApplicationRelaunchResult {
  relaunching: true;
}

export type DesktopPolicyStatus =
  | 'allowed'
  | 'denied'
  | 'needs_approval'
  | 'unsupported';

export type DesktopGatewayDecision = 'allowed' | 'denied';
export type DesktopGatewayOutcome = 'ok' | 'not_run' | 'failed';

export interface DesktopGatewayContext {
  instanceId: string;
  provider?: string;
}

export interface DesktopGatewayResult<T = unknown> {
  decision: DesktopGatewayDecision;
  outcome: DesktopGatewayOutcome;
  reason?: string;
  data?: T;
}

export interface DesktopDriverHealth {
  platform: string;
  supported: boolean;
  screenCapture: DesktopCapabilityState;
  accessibility: DesktopCapabilityState;
  input: DesktopCapabilityState;
  setupActions: string[];
}

export interface DesktopSessionLockHolder {
  instanceId?: string;
  provider?: string;
  appId?: string;
  startedAt?: number;
  purpose?: string;
}

export interface DesktopHealthData extends DesktopDriverHealth {
  enabled: boolean;
  lockAvailable: boolean;
  injectable: boolean;
  /**
   * When a desktop-use session lock is currently held, the sanitized holder
   * metadata. Never contains prompt text or task details.
   */
  lockHolder?: DesktopSessionLockHolder;
}

export interface DesktopAppDescriptor {
  appId: string;
  displayName: string;
  platform: string;
  bundleId?: string;
  executablePath?: string;
  pid?: number;
  /** The app's frontmost visible window. */
  windowId?: string;
  visibleWindowCount: number;
  /**
   * Every visible window, front-most first. Needed to target a specific window
   * of a multi-window app (and to tell windows on different monitors apart)
   * rather than only whichever one happens to be in front.
   */
  windows?: DesktopWindowDescriptor[];
  policyStatus?: DesktopPolicyStatus;
  blockedReason?: string;
}

export interface DesktopWindowDescriptor {
  windowId: string;
  title?: string;
  bounds?: DesktopRegion;
}

export interface DesktopRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopScreenshotRequest {
  appId?: string;
  windowId?: string;
  displayId?: string;
  region?: DesktopRegion;
  scale?: number;
  metadata?: Record<string, unknown>;
}

export interface DesktopScreenshotResult {
  appId: string;
  windowId?: string;
  displayId?: string;
  data: string;
  mimeType: string;
  width: number;
  height: number;
  capturedAt: number;
  observationToken?: string;
}

export interface DesktopAccessibilityNode {
  uid: string;
  role: string;
  label?: string;
  value?: string;
  /**
   * Link destination (AXURL). Present only on link-like elements, and only from
   * helper builds that report it — action classification therefore treats an
   * absent url as "no navigation proof" rather than "not a link".
   */
  url?: string;
  bounds?: DesktopRegion;
  enabled?: boolean;
  focused?: boolean;
  redacted?: boolean;
  children?: DesktopAccessibilityNode[];
}

export interface DesktopAccessibilitySnapshotRequest {
  appId?: string;
  windowId?: string;
  maxNodes?: number;
  includeBounds?: boolean;
  roleFilters?: string[];
}

export interface DesktopAccessibilitySnapshotResult {
  appId: string;
  windowId?: string;
  nodes: DesktopAccessibilityNode[];
  focusedUid?: string;
  capturedAt: number;
  observationToken?: string;
}

export type DesktopGrantCapability = 'observe' | 'input' | 'observeAndInput';
export type DesktopGrantDuration = 'session' | 'untilRevoked' | 'boundedMinutes';
export type DesktopApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'unknown';

export interface DesktopGrantRequest {
  appId: string;
  capability: DesktopGrantCapability;
  reason: string;
  duration: DesktopGrantDuration;
  minutes?: number;
}

export interface DesktopGrantRequestStatus {
  requestId: string;
  status: DesktopApprovalStatus;
  appId: string;
  capability: DesktopGrantCapability;
  requestedAt: number;
  grantId?: string;
  expiresAt?: number;
}

export interface DesktopPoint {
  x: number;
  y: number;
}

export type DesktopMouseButton = 'left' | 'middle' | 'right';
export type DesktopScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface DesktopInputActionRequest {
  appId: string;
  observationToken: string;
  /** Internal binding copied from the observation; callers cannot override it. */
  windowId?: string;
  sensitive?: boolean;
  metadata?: Record<string, unknown>;
}

export interface DesktopClickRequest extends DesktopInputActionRequest {
  elementUid?: string;
  x?: number;
  y?: number;
  button?: DesktopMouseButton;
  clickCount?: number;
}

export interface DesktopTypeTextRequest extends DesktopInputActionRequest {
  text: string;
  elementUid?: string;
}

export interface DesktopHotkeyRequest extends DesktopInputActionRequest {
  keys: string[];
}

export interface DesktopScrollRequest extends DesktopInputActionRequest {
  direction: DesktopScrollDirection;
  amount: number;
  elementUid?: string;
  x?: number;
  y?: number;
}

export interface DesktopDragRequest extends DesktopInputActionRequest {
  start: DesktopPoint;
  end: DesktopPoint;
  durationMs?: number;
}

export type DesktopWaitCondition = {
  text?: string;
  role?: string;
  label?: string;
};

export interface DesktopWaitForRequest {
  appId: string;
  condition: DesktopWaitCondition;
  timeoutMs?: number;
}

export interface DesktopActionResult {
  status: 'ok';
  appId?: string;
  completedAt?: number;
}

/**
 * Bring one already-observed window of an already-granted app to the front.
 * A navigation prerequisite so a later input action can satisfy the driver's
 * "target must be active" rule — NOT permission to mutate the app. Subsequent
 * clicks/typing keep the normal action policy.
 */
export interface DesktopActivateWindowRequest {
  appId: string;
  observationToken: string;
  /** Defaults to the window the observation was captured against. */
  windowId?: string;
  metadata?: Record<string, unknown>;
}

export interface DesktopActivateWindowResult {
  activated: boolean;
  appId: string;
  /** The window that is actually frontmost after activation, as verified. */
  activeWindow?: DesktopWindowDescriptor;
  /**
   * Observation tokens are bound to the snapshot they were captured with, so
   * activation deliberately mints none: re-observe the app after activating to
   * get element handles for the window that is now in front.
   */
  reobserveRequired: true;
}

export interface DesktopWaitForResult {
  matched: boolean;
  explanation: string;
  appId: string;
  observationToken?: string;
}

export interface DesktopGrantResolutionRequest {
  requestId: string;
  approved: boolean;
  decidedBy: string;
  reason?: string;
}

export interface DesktopQueryElementsRequest {
  observationToken: string;
  appId?: string;
  text?: string;
  role?: string;
  label?: string;
  value?: string;
  limit?: number;
}

export interface DesktopElementCandidate {
  uid: string;
  role: string;
  label?: string;
  value?: string;
  /** Link destination (AXURL); see DesktopAccessibilityNode.url. */
  url?: string;
  bounds?: DesktopRegion;
  enabled?: boolean;
  focused?: boolean;
  redacted?: boolean;
}

export interface DesktopQueryElementsResult {
  appId: string;
  candidates: DesktopElementCandidate[];
  observationToken?: string;
}

export interface DesktopGrantSummary {
  id: string;
  appId: string;
  capability: DesktopGrantCapability;
  createdAt: number;
  expiresAt: number;
  scope: 'session' | 'durable';
  decidedBy: string;
  reason?: string;
  revokedAt?: number;
}

export interface DesktopListGrantsRequest {
  appId?: string;
  includeExpired?: boolean;
  limit?: number;
}

export interface DesktopRevokeGrantRequest {
  grantId: string;
  reason?: string;
}

export interface DesktopRevokeGrantResult {
  grantId: string;
  revoked: boolean;
}

export interface DesktopAuditEntry {
  id: string;
  timestamp: number;
  instanceId: string;
  provider?: string;
  toolName: string;
  appId?: string;
  grantId?: string;
  decision: DesktopGatewayDecision;
  resultCode: DesktopGatewayOutcome | string;
  reason?: string;
  redactedMetadata?: Record<string, unknown>;
}

export type DesktopEscalationKind =
  | 'login'
  | 'captcha'
  | 'two_factor'
  | 'credential_request'
  | 'payment'
  | 'admin_prompt'
  | 'destructive_action'
  | 'unknown_modal'
  | 'wrong_app'
  | 'other';
