import { z } from 'zod';

const idSchema = z.string().min(1).max(200);
const urlSchema = z.string().min(1).max(2000);
const optionalUrlSchema = urlSchema.optional();

export const BrowserActionClassSchema = z.enum([
  'read',
  'navigate',
  'input',
  'credential',
  'file-upload',
  'submit',
  'destructive',
  'unknown',
]);
export type BrowserActionClass = z.infer<typeof BrowserActionClassSchema>;

export const BrowserProfileModeSchema = z.enum(['session', 'isolated']);
export const BrowserProfileBrowserSchema = z.literal('chrome');
export const BrowserProfileStatusSchema = z.enum([
  'stopped',
  'starting',
  'running',
  'stopping',
  'locked',
  'error',
]);
export const BrowserTargetModeSchema = z.enum([
  'session',
  'isolated',
  'existing-tab',
]);
export const BrowserTargetDriverSchema = z.enum([
  'chrome-devtools-mcp',
  'cdp',
  'playwright',
  'extension',
]);
export const BrowserTargetStatusSchema = z.enum([
  'available',
  'selected',
  'busy',
  'closed',
  'error',
]);
export const BrowserGatewayDecisionSchema = z.enum([
  'allowed',
  'denied',
  'requires_user',
]);
export const BrowserGatewayOutcomeSchema = z.enum([
  'not_run',
  'succeeded',
  'failed',
]);
export const BrowserGrantModeSchema = z.enum([
  'per_action',
  'session',
  'autonomous',
]);
export type BrowserGrantMode = z.infer<typeof BrowserGrantModeSchema>;
export const BrowserApprovalRequestStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'expired',
]);
export type BrowserApprovalRequestStatus = z.infer<
  typeof BrowserApprovalRequestStatusSchema
>;
export const BrowserProviderSchema = z.enum([
  'claude',
  'codex',
  'gemini',
  'copilot',
  'orchestrator',
]);

export const BrowserAllowedOriginSchema = z
  .object({
    scheme: z.enum(['https', 'http']),
    hostPattern: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).optional(),
    includeSubdomains: z.boolean(),
  })
  .strict();
export type BrowserAllowedOrigin = z.infer<typeof BrowserAllowedOriginSchema>;

export const BrowserProfileSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(120),
    mode: BrowserProfileModeSchema,
    browser: BrowserProfileBrowserSchema,
    userDataDir: z.string().min(1).max(2000).optional(),
    allowedOrigins: z.array(BrowserAllowedOriginSchema),
    defaultUrl: optionalUrlSchema,
    status: BrowserProfileStatusSchema,
    debugPort: z.number().int().min(1).max(65535).optional(),
    debugEndpoint: urlSchema.optional(),
    processId: z.number().int().positive().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    lastLaunchedAt: z.number().int().nonnegative().optional(),
    lastUsedAt: z.number().int().nonnegative().optional(),
    lastLoginCheckAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>;

export const BrowserTargetSchema = z
  .object({
    id: idSchema,
    profileId: idSchema.optional(),
    pageId: idSchema.optional(),
    driverTargetId: idSchema.optional(),
    mode: BrowserTargetModeSchema,
    title: z.string().min(1).max(500).optional(),
    url: optionalUrlSchema,
    origin: z.string().min(1).max(2000).optional(),
    driver: BrowserTargetDriverSchema,
    status: BrowserTargetStatusSchema,
    lastSeenAt: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>;

export const BrowserElementContextSchema = z
  .object({
    role: z.string().min(1).max(120).optional(),
    accessibleName: z.string().min(1).max(500).optional(),
    visibleText: z.string().min(1).max(2000).optional(),
    inputType: z.string().min(1).max(120).optional(),
    inputName: z.string().min(1).max(500).optional(),
    placeholder: z.string().min(1).max(500).optional(),
    label: z.string().min(1).max(500).optional(),
    formAction: optionalUrlSchema,
    attributes: z.record(z.string(), z.string().max(1000)).optional(),
    nearbyText: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type BrowserElementContext = z.infer<typeof BrowserElementContextSchema>;

export const BrowserGrantProposalSchema = z
  .object({
    mode: BrowserGrantModeSchema,
    allowedOrigins: z.array(BrowserAllowedOriginSchema).min(1),
    allowedActionClasses: z.array(BrowserActionClassSchema).min(1),
    allowExternalNavigation: z.boolean(),
    uploadRoots: z.array(z.string().min(1).max(2000)).optional(),
    autonomous: z.boolean(),
  })
  .strict();
export type BrowserGrantProposal = z.infer<typeof BrowserGrantProposalSchema>;

export const BrowserPermissionGrantSchema = z
  .object({
    id: idSchema,
    mode: BrowserGrantModeSchema,
    instanceId: idSchema,
    provider: BrowserProviderSchema,
    profileId: idSchema.optional(),
    targetId: idSchema.optional(),
    allowedOrigins: z.array(BrowserAllowedOriginSchema).min(1),
    allowedActionClasses: z.array(BrowserActionClassSchema).min(1),
    allowExternalNavigation: z.boolean(),
    uploadRoots: z.array(z.string().min(1).max(2000)).optional(),
    autonomous: z.boolean(),
    requestedBy: z.string().min(1).max(200),
    decidedBy: z.enum(['user', 'timeout', 'revoked']),
    decision: z.enum(['allow', 'deny']),
    reason: z.string().min(1).max(1000).optional(),
    expiresAt: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    revokedAt: z.number().int().nonnegative().optional(),
    consumedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === 'autonomous') {
      if (!value.autonomous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['autonomous'],
          message: 'Autonomous grants must set autonomous=true.',
        });
      }
      if (value.expiresAt - value.createdAt > 86_400_000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expiresAt'],
          message: 'Autonomous browser grants cannot exceed 24 hours.',
        });
      }
    }
  });
export type BrowserPermissionGrant = z.infer<typeof BrowserPermissionGrantSchema>;

export const BrowserApprovalRequestSchema = z
  .object({
    id: idSchema,
    requestId: idSchema,
    instanceId: idSchema,
    provider: BrowserProviderSchema,
    profileId: idSchema,
    targetId: idSchema.optional(),
    toolName: z.string().min(1).max(200),
    action: z.string().min(1).max(120),
    actionClass: BrowserActionClassSchema,
    origin: z.string().min(1).max(2000).optional(),
    url: optionalUrlSchema,
    selector: z.string().min(1).max(2000).optional(),
    elementContext: BrowserElementContextSchema.optional(),
    filePath: z.string().min(1).max(2000).optional(),
    detectedFileType: z.string().min(1).max(120).optional(),
    proposedGrant: BrowserGrantProposalSchema,
    status: BrowserApprovalRequestStatusSchema,
    grantId: idSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    decidedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.id !== value.requestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestId'],
        message: 'Browser approval id and requestId must match.',
      });
    }
  });
export type BrowserApprovalRequest = z.infer<typeof BrowserApprovalRequestSchema>;

export const BrowserAuditEntrySchema = z
  .object({
    id: idSchema,
    instanceId: idSchema.optional(),
    provider: z.string().min(1).max(100),
    profileId: idSchema.optional(),
    targetId: idSchema.optional(),
    action: z.string().min(1).max(120),
    toolName: z.string().min(1).max(200),
    actionClass: BrowserActionClassSchema,
    origin: z.string().min(1).max(2000).optional(),
    url: optionalUrlSchema,
    decision: BrowserGatewayDecisionSchema,
    outcome: BrowserGatewayOutcomeSchema,
    summary: z.string().min(1).max(2000),
    redactionApplied: z.boolean(),
    screenshotArtifactId: idSchema.optional(),
    requestId: idSchema.optional(),
    grantId: idSchema.optional(),
    autonomous: z.boolean().optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserAuditEntry = z.infer<typeof BrowserAuditEntrySchema>;

export const BrowserGatewayResultSchema = z
  .object({
    decision: BrowserGatewayDecisionSchema,
    outcome: BrowserGatewayOutcomeSchema,
    data: z.unknown().optional(),
    reason: z.string().min(1).max(1000).optional(),
    requestId: idSchema.optional(),
    auditId: idSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === 'allowed' && value.outcome === 'not_run') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'Allowed browser gateway results must succeed or fail after running.',
      });
    }
    if (value.decision !== 'allowed' && value.outcome !== 'not_run') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'Denied and requires_user browser gateway results must not run.',
      });
    }
    if (value.decision === 'requires_user' && !value.requestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestId'],
        message: 'Browser gateway requires_user results must include requestId.',
      });
    }
  });
export type BrowserGatewayResult = z.infer<typeof BrowserGatewayResultSchema>;

export const BrowserCreateProfileRequestSchema = z
  .object({
    label: z.string().min(1).max(120),
    mode: BrowserProfileModeSchema,
    browser: BrowserProfileBrowserSchema,
    allowedOrigins: z.array(BrowserAllowedOriginSchema),
    defaultUrl: optionalUrlSchema,
  })
  .strict();
export type BrowserCreateProfileRequest = z.infer<
  typeof BrowserCreateProfileRequestSchema
>;

export const BrowserUpdateProfileRequestSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    allowedOrigins: z.array(BrowserAllowedOriginSchema).optional(),
    defaultUrl: z.union([urlSchema, z.null()]).optional(),
  })
  .strict();
export type BrowserUpdateProfileRequest = z.infer<
  typeof BrowserUpdateProfileRequestSchema
>;

export const BrowserUpdateProfilePayloadSchema = BrowserUpdateProfileRequestSchema.extend({
  profileId: idSchema,
}).strict();
export type BrowserUpdateProfilePayload = z.infer<
  typeof BrowserUpdateProfilePayloadSchema
>;

export const BrowserProfileRequestSchema = z
  .object({
    profileId: idSchema,
  })
  .strict();
export type BrowserProfileRequest = z.infer<typeof BrowserProfileRequestSchema>;

export const BrowserListTargetsRequestSchema = z
  .object({
    profileId: idSchema.optional(),
  })
  .strict();
export type BrowserListTargetsRequest = z.infer<
  typeof BrowserListTargetsRequestSchema
>;

export const BrowserTargetRequestSchema = z
  .object({
    profileId: idSchema,
    targetId: idSchema,
  })
  .strict();
export type BrowserTargetRequest = z.infer<typeof BrowserTargetRequestSchema>;

export const BrowserNavigateRequestSchema = BrowserTargetRequestSchema.extend({
  url: urlSchema,
}).strict();
export type BrowserNavigateRequest = z.infer<typeof BrowserNavigateRequestSchema>;

export const BrowserScreenshotRequestSchema = BrowserTargetRequestSchema.extend({
  maxWidth: z.number().int().min(100).max(4096).optional(),
  maxHeight: z.number().int().min(100).max(4096).optional(),
  fullPage: z.boolean().optional(),
}).strict();
export type BrowserScreenshotRequest = z.infer<
  typeof BrowserScreenshotRequestSchema
>;

export const BrowserWaitForRequestSchema = BrowserTargetRequestSchema.extend({
  selector: z.string().min(1).max(2000).optional(),
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
}).strict();
export type BrowserWaitForRequest = z.infer<typeof BrowserWaitForRequestSchema>;

export const BrowserClickRequestSchema = BrowserTargetRequestSchema.extend({
  selector: z.string().min(1).max(2000),
  actionHint: z.string().min(1).max(500).optional(),
  requestId: idSchema.optional(),
}).strict();
export type BrowserClickRequest = z.infer<typeof BrowserClickRequestSchema>;

export const BrowserTypeRequestSchema = BrowserTargetRequestSchema.extend({
  selector: z.string().min(1).max(2000),
  value: z.string().max(20_000),
  actionHint: z.string().min(1).max(500).optional(),
  requestId: idSchema.optional(),
}).strict();
export type BrowserTypeRequest = z.infer<typeof BrowserTypeRequestSchema>;

export const BrowserFillFormFieldSchema = z
  .object({
    selector: z.string().min(1).max(2000),
    value: z.string().max(20_000),
    actionHint: z.string().min(1).max(500).optional(),
  })
  .strict();
export type BrowserFillFormField = z.infer<typeof BrowserFillFormFieldSchema>;

export const BrowserFillFormRequestSchema = BrowserTargetRequestSchema.extend({
  fields: z.array(BrowserFillFormFieldSchema).min(1).max(100),
  requestId: idSchema.optional(),
}).strict();
export type BrowserFillFormRequest = z.infer<typeof BrowserFillFormRequestSchema>;

export const BrowserSelectRequestSchema = BrowserTargetRequestSchema.extend({
  selector: z.string().min(1).max(2000),
  value: z.string().min(1).max(2000),
  actionHint: z.string().min(1).max(500).optional(),
  requestId: idSchema.optional(),
}).strict();
export type BrowserSelectRequest = z.infer<typeof BrowserSelectRequestSchema>;

export const BrowserUploadFileRequestSchema = BrowserTargetRequestSchema.extend({
  selector: z.string().min(1).max(2000),
  filePath: z.string().min(1).max(2000),
  actionHint: z.string().min(1).max(500).optional(),
  requestId: idSchema.optional(),
}).strict();
export type BrowserUploadFileRequest = z.infer<typeof BrowserUploadFileRequestSchema>;

export const BrowserApprovalStatusRequestSchema = z
  .object({
    requestId: idSchema,
  })
  .strict();
export type BrowserApprovalStatusRequest = z.infer<
  typeof BrowserApprovalStatusRequestSchema
>;

export const BrowserApprovalRequestLookupSchema = z
  .object({
    requestId: idSchema,
  })
  .strict();
export type BrowserApprovalRequestLookup = z.infer<
  typeof BrowserApprovalRequestLookupSchema
>;

export const BrowserApproveRequestPayloadSchema = z
  .object({
    requestId: idSchema,
    grant: BrowserGrantProposalSchema,
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type BrowserApproveRequestPayload = z.infer<
  typeof BrowserApproveRequestPayloadSchema
>;

export const BrowserDenyRequestPayloadSchema = z
  .object({
    requestId: idSchema,
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type BrowserDenyRequestPayload = z.infer<
  typeof BrowserDenyRequestPayloadSchema
>;

export const BrowserCreateGrantRequestSchema = BrowserGrantProposalSchema.extend({
  instanceId: idSchema,
  provider: BrowserProviderSchema,
  profileId: idSchema.optional(),
  targetId: idSchema.optional(),
  requestedBy: z.string().min(1).max(200),
  expiresAt: z.number().int().nonnegative(),
  reason: z.string().min(1).max(1000).optional(),
}).strict();
export type BrowserCreateGrantRequest = z.infer<
  typeof BrowserCreateGrantRequestSchema
>;

export const BrowserListGrantsRequestSchema = z
  .object({
    instanceId: idSchema.optional(),
    profileId: idSchema.optional(),
    includeExpired: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type BrowserListGrantsRequest = z.infer<
  typeof BrowserListGrantsRequestSchema
>;

export const BrowserRevokeGrantRequestSchema = z
  .object({
    grantId: idSchema,
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type BrowserRevokeGrantRequest = z.infer<
  typeof BrowserRevokeGrantRequestSchema
>;

export const BrowserListApprovalRequestsRequestSchema = z
  .object({
    instanceId: idSchema.optional(),
    status: BrowserApprovalRequestStatusSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type BrowserListApprovalRequestsRequest = z.infer<
  typeof BrowserListApprovalRequestsRequestSchema
>;

export const BrowserRequestGrantRequestSchema = BrowserTargetRequestSchema.extend({
  proposedGrant: BrowserGrantProposalSchema,
  reason: z.string().min(1).max(1000).optional(),
}).strict();
export type BrowserRequestGrantRequest = z.infer<
  typeof BrowserRequestGrantRequestSchema
>;

export const BrowserListAuditLogRequestSchema = z
  .object({
    profileId: idSchema.optional(),
    instanceId: idSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type BrowserListAuditLogRequest = z.infer<
  typeof BrowserListAuditLogRequestSchema
>;
