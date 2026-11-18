/**
 * One approval to release secret-observation protection for exactly the
 * reviewed origins of one shared tab. Never a browser grant, a vault permission
 * or approval to submit anything.
 */
export interface BrowserSecretRecoveryMetadata {
  operationId: string;
  ownerSessionId: string;
  /** 'local' or the remote computer's id. */
  nodeId: string;
  computerName: string;
  extensionInstanceId?: string;
  targetId: string;
  /** Exact protected origins present in the tab, sorted. */
  origins: string[];
  /** Tracked tabs (including tabs opened from them) that carry these origins. */
  affectedTabCount: number;
  /** The extension's write generation this review saw. Any later secret write changes it. */
  writeGeneration: string;
  expiresAt: number;
}

export type BrowserSecretRecoveryProgressState =
  | 'running'
  | 'recovered'
  | 'stale_review'
  | 'manual_security_review_required'
  | 'failed'
  | 'indeterminate';

/** What Harness did after approval. Written by Harness only, never from page content. */
export interface BrowserSecretRecoveryProgress {
  state: BrowserSecretRecoveryProgressState;
  reasonCode: string;
  /** Separate from recovery: true signed in, false signed out, null not checked or unknown. */
  loginVerified: boolean | null;
  clearedTabCount?: number;
  receiptId?: string;
  updatedAt: number;
}

export interface BrowserSecretRecoveryChoice { permission: 'operation' }

export type BrowserSecretRecoveryState =
  | 'approval_pending'
  | 'approved'
  | BrowserSecretRecoveryProgressState
  | 'not_protected'
  | 'denied'
  | 'unsupported_extension';

export interface BrowserRecoverSecretObservationRequest {
  profileId: string;
  targetId: string;
  reason?: string;
  /** The request id from an earlier call: reports (or resumes) that recovery. */
  requestId?: string;
}

/** Everything an agent gets back. Fixed codes only, never page content. */
export interface BrowserSecretRecoveryOutcome {
  state: BrowserSecretRecoveryState;
  reasonCode: string;
  loginVerified: boolean | null;
  requestId?: string;
  receiptId?: string;
  origins?: string[];
  affectedTabCount?: number;
  nextAction: string;
}
