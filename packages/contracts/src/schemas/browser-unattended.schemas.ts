import { z } from 'zod';

/**
 * Schemas for the unattended browser-automation trigger surfaces: credential
 * vault unlock/lock/status, standing credential authorizations, overnight
 * browser campaigns, and the escalation triage queue.
 *
 * These are RENDERER-ONLY IPC payloads (James-approved dialogs) — they are
 * deliberately NOT exposed as MCP tools. Authorization + campaign creation is
 * user-approved only. No schema here ever carries a secret: vault unlock reads
 * the master password from a local file configured in settings, never from the
 * renderer payload.
 *
 * Sibling file to browser.schemas.ts (which sits at the file-size ceiling);
 * self-contained to avoid an import cycle.
 */

const idSchema = z.string().min(1).max(200);

export const BrowserCredentialPurposeSchema = z.enum([
  'login',
  'register',
  'totp',
  'email_code',
]);
export type BrowserCredentialPurpose = z.infer<typeof BrowserCredentialPurposeSchema>;

export const BrowserAuthorizationOriginSchema = z
  .object({
    scheme: z.enum(['https', 'http']),
    hostPattern: z.string().min(1).max(500),
    includeSubdomains: z.boolean(),
  })
  .strict();
export type BrowserAuthorizationOrigin = z.infer<typeof BrowserAuthorizationOriginSchema>;

// ── Vault ───────────────────────────────────────────────────────────────────

/** Unlock takes no renderer input — the master password source is settings-side. */
export const BrowserVaultUnlockRequestSchema = z.object({}).strict();
export type BrowserVaultUnlockRequest = z.infer<typeof BrowserVaultUnlockRequestSchema>;

// ── Credential authorizations ───────────────────────────────────────────────

export const BrowserCreateCredentialAuthorizationRequestSchema = z
  .object({
    profileId: idSchema,
    allowedOrigins: z.array(BrowserAuthorizationOriginSchema).min(1).max(20),
    purposes: z.array(BrowserCredentialPurposeSchema).min(1),
    vaultFolder: z.string().min(1).max(200),
    /** Epoch ms. Standing consent — weeks/months out, validated in the handler. */
    expiresAt: z.number().int().positive(),
    note: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type BrowserCreateCredentialAuthorizationRequest = z.infer<
  typeof BrowserCreateCredentialAuthorizationRequestSchema
>;

export const BrowserListCredentialAuthorizationsRequestSchema = z
  .object({
    profileId: idSchema.optional(),
  })
  .strict();
export type BrowserListCredentialAuthorizationsRequest = z.infer<
  typeof BrowserListCredentialAuthorizationsRequestSchema
>;

export const BrowserRevokeCredentialAuthorizationRequestSchema = z
  .object({
    authorizationId: idSchema,
  })
  .strict();
export type BrowserRevokeCredentialAuthorizationRequest = z.infer<
  typeof BrowserRevokeCredentialAuthorizationRequestSchema
>;

// ── Campaigns ───────────────────────────────────────────────────────────────

export const BrowserCampaignBudgetSchema = z
  .object({
    maxActions: z.number().int().min(1).max(100_000),
    maxSubmits: z.number().int().min(0).max(10_000),
    maxNewAccounts: z.number().int().min(0).max(100),
    maxUploads: z.number().int().min(0).max(1_000),
    /** Wall-clock budget; the campaign service enforces the 14h hard ceiling. */
    maxDurationMs: z.number().int().min(60_000),
  })
  .strict();
export type BrowserCampaignBudgetPayload = z.infer<typeof BrowserCampaignBudgetSchema>;

export const BrowserCreateCampaignRequestSchema = z
  .object({
    label: z.string().min(1).max(200),
    profileId: idSchema,
    allowedOrigins: z.array(z.string().min(1).max(500)).min(1).max(50),
    /** The campaign service rejects credential/payment/destructive. */
    allowedActionClasses: z.array(z.string().min(1).max(50)).min(1).max(10),
    budget: BrowserCampaignBudgetSchema,
  })
  .strict();
export type BrowserCreateCampaignRequest = z.infer<typeof BrowserCreateCampaignRequestSchema>;

export const BrowserCampaignStatusFilterSchema = z.enum([
  'active',
  'paused',
  'killed',
  'completed',
  'expired',
]);

export const BrowserListCampaignsRequestSchema = z
  .object({
    status: BrowserCampaignStatusFilterSchema.optional(),
  })
  .strict();
export type BrowserListCampaignsRequest = z.infer<typeof BrowserListCampaignsRequestSchema>;

export const BrowserCampaignLookupRequestSchema = z
  .object({
    campaignId: idSchema,
  })
  .strict();
export type BrowserCampaignLookupRequest = z.infer<typeof BrowserCampaignLookupRequestSchema>;

export const BrowserApproveCampaignDeclarationRequestSchema = z
  .object({
    campaignId: idSchema,
    /** SHA-256 hex of the declaration text being pre-approved. */
    declarationHash: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();
export type BrowserApproveCampaignDeclarationRequest = z.infer<
  typeof BrowserApproveCampaignDeclarationRequestSchema
>;

// ── Escalations ─────────────────────────────────────────────────────────────

export const BrowserEscalationStatusFilterSchema = z.enum(['pending', 'resolved', 'skipped']);

export const BrowserListEscalationsRequestSchema = z
  .object({
    campaignId: idSchema.optional(),
    profileId: idSchema.optional(),
    status: BrowserEscalationStatusFilterSchema.optional(),
  })
  .strict();
export type BrowserListEscalationsRequest = z.infer<typeof BrowserListEscalationsRequestSchema>;

export const BrowserResolveEscalationRequestSchema = z
  .object({
    escalationId: idSchema,
    note: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type BrowserResolveEscalationRequest = z.infer<
  typeof BrowserResolveEscalationRequestSchema
>;

// ── Agent-facing runtime surfaces (MCP; validated in the RPC server) ────────

export const BrowserEscalationKindSchema = z.enum([
  'captcha',
  'two_factor_unavailable',
  'legal_declaration',
  'payment',
  'relogin_failed',
  'verify_diff',
  'unknown_challenge',
]);

export const BrowserRaiseEscalationRequestSchema = z
  .object({
    campaignId: idSchema.optional(),
    profileId: idSchema,
    targetId: idSchema.optional(),
    kind: BrowserEscalationKindSchema,
    reason: z.string().min(1).max(2000),
    url: z.string().min(1).max(2000).optional(),
    screenshotArtifactId: idSchema.optional(),
  })
  .strict();
export type BrowserRaiseEscalationRequest = z.infer<typeof BrowserRaiseEscalationRequestSchema>;

export const BrowserClaimCampaignLeaseRequestSchema = z
  .object({
    campaignId: idSchema,
  })
  .strict();
export type BrowserClaimCampaignLeaseRequest = z.infer<
  typeof BrowserClaimCampaignLeaseRequestSchema
>;

export const BrowserCheckSessionRequestSchema = z
  .object({
    profileId: idSchema,
    targetId: idSchema,
    autoRelogin: z.boolean().optional(),
    campaignId: idSchema.optional(),
  })
  .strict();
export type BrowserCheckSessionRequest = z.infer<typeof BrowserCheckSessionRequestSchema>;

export const BrowserRememberLoginFingerprintRequestSchema = z
  .object({
    profileId: idSchema,
    origin: z.string().url().max(2000),
    loginUrl: z.string().url().max(2000),
    loggedInMarkers: z.array(z.string().min(1).max(200)).min(1).max(10),
    relogin: z
      .object({
        // A vault item reference, never a secret.
        vaultItemRef: z.string().min(1).max(200),
        usernameSelector: z.string().min(1).max(2000).optional(),
        passwordSelector: z.string().min(1).max(2000),
        submitSelector: z.string().min(1).max(2000).optional(),
        codeSelector: z.string().min(1).max(2000).optional(),
        codeKind: z.enum(['totp', 'email_code']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrowserRememberLoginFingerprintRequest = z.infer<
  typeof BrowserRememberLoginFingerprintRequestSchema
>;
