export type DesktopCapabilityState =
  | 'available'
  | 'missing_permission'
  | 'unavailable'
  | 'unsupported';

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
  windowId?: string;
  visibleWindowCount: number;
  policyStatus?: DesktopPolicyStatus;
  blockedReason?: string;
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
