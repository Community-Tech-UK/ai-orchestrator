/**
 * Renderer-side types for the unattended browser-automation layer: vault
 * unlock/lock/status, standing credential authorizations, overnight
 * campaigns, and the escalation triage queue.
 *
 * Mirrors the main-process shapes in
 * `src/main/browser-gateway/browser-unattended-services.ts`,
 * `browser-credential-authorization-store.ts`, `browser-campaign-store.ts`,
 * and `browser-escalation-store.ts` (read-only reference — this file is the
 * renderer's own copy, not an import, per the Item 2 scope boundary).
 */

export type CredentialPurpose = 'login' | 'register' | 'totp' | 'email_code';

export interface CredentialAuthorizationOrigin {
  scheme: 'https' | 'http';
  hostPattern: string;
  includeSubdomains: boolean;
}

export interface CredentialAuthorization {
  id: string;
  profileId: string;
  allowedOrigins: CredentialAuthorizationOrigin[];
  purposes: CredentialPurpose[];
  vaultFolder: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  note?: string;
}

export interface CreateCredentialAuthorizationPayload {
  profileId: string;
  allowedOrigins: CredentialAuthorizationOrigin[];
  purposes: CredentialPurpose[];
  vaultFolder: string;
  expiresAt: number;
  note?: string;
}

export type BrowserVaultUnlockReason = 'empty_password' | 'bw_unlock_failed' | 'empty_session';

export interface BrowserVaultUnlockResult {
  unlocked: boolean;
  reason?: BrowserVaultUnlockReason;
}

export interface BrowserVaultStatus {
  locked: boolean;
  passwordSourceConfigured: boolean;
}

/** Action classes safe to offer in the campaign creation UI. Credential,
 * payment, and destructive classes must never be presented as campaign
 * options — a campaign is unattended, so those classes stay gated behind the
 * per-action approval dialogs instead. */
export const CAMPAIGN_ALLOWED_ACTION_CLASSES = [
  'read',
  'navigate',
  'input',
  'submit',
  'file-upload',
  'file-download',
] as const;
export type CampaignActionClass = (typeof CAMPAIGN_ALLOWED_ACTION_CLASSES)[number];

/** Hard ceiling for a campaign's wall-clock budget: an "overnight" window,
 * not an open-ended standing permission. Enforced server-side too. */
export const CAMPAIGN_MAX_DURATION_MS = 14 * 60 * 60 * 1000;

export interface BrowserCampaignBudget {
  maxActions: number;
  maxSubmits: number;
  maxNewAccounts: number;
  maxUploads: number;
  maxDurationMs: number;
}

export type BrowserCampaignStatus = 'active' | 'paused' | 'killed' | 'completed' | 'expired';

export interface BrowserCampaign {
  id: string;
  label: string;
  profileId: string;
  allowedOrigins: string[];
  allowedActionClasses: string[];
  budget: BrowserCampaignBudget;
  approvedDeclarationHashes: string[];
  status: BrowserCampaignStatus;
  createdAt: number;
  expiresAt: number;
  approvedBy: 'user';
}

export interface BrowserCampaignCounters {
  actions: number;
  submits: number;
  newAccounts: number;
  uploads: number;
}

export interface CreateBrowserCampaignPayload {
  label: string;
  profileId: string;
  allowedOrigins: string[];
  allowedActionClasses: string[];
  budget: BrowserCampaignBudget;
}

export interface BrowserCampaignListItem {
  campaign: BrowserCampaign;
  counters: BrowserCampaignCounters | null;
}

export interface BrowserCampaignDetail {
  campaign: BrowserCampaign;
  counters: BrowserCampaignCounters | null;
  pendingEscalations: number;
}

export type BrowserEscalationKind =
  | 'captcha'
  | 'two_factor_unavailable'
  | 'legal_declaration'
  | 'payment'
  | 'relogin_failed'
  | 'verify_diff'
  | 'unknown_challenge';

export type BrowserEscalationStatus = 'pending' | 'resolved' | 'skipped';

export interface BrowserEscalation {
  id: string;
  campaignId?: string;
  profileId: string;
  targetId?: string;
  kind: BrowserEscalationKind;
  reason: string;
  url?: string;
  status: BrowserEscalationStatus;
  createdAt: number;
  resolvedAt?: number;
  resolutionNote?: string;
}
