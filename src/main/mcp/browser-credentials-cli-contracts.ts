import { z } from 'zod';
import {
  BrowserAuthorizationOriginSchema,
  BrowserCreateCredentialAuthorizationRequestSchema,
  BrowserEnrolCredentialRequestSchema,
  BrowserListCredentialAuthorizationsRequestSchema,
  BrowserRevokeCredentialAuthorizationRequestSchema,
} from '@contracts/schemas/browser-unattended';
import {
  BrowserApprovalRequestSchema,
  BrowserCredentialAccessLookupSchema,
  BrowserGatewayResultSchema,
  BrowserRequestCredentialAccessSchema,
} from '@contracts/schemas/browser';

/**
 * Contract for `aio-mcp browser-credentials`: request operator approval for
 * saved-login access, and inspect/cancel requests or inspect/revoke permissions.
 *
 * 2026-08-29 DELIBERATE WIDENING, authorised by the operator (James).
 *
 * Legacy enrol/authorize payloads remain for internal operator compatibility.
 * Since the saved-login approval flow, authenticated session RPC rejects those
 * mutations: session identity is not operator consent. New access is requested
 * through the shared approval service, including in YOLO mode. Operator IPC and
 * explicitly configured bootstrap services retain their separate routes.
 *
 * What was kept, deliberately:
 *   - The payload schemas are the SAME objects the renderer IPC uses, not
 *     parallel copies, so the CLI cannot accept a shape the panel would refuse.
 *   - `secret_fill` is not an offerable purpose here, matching the IPC surface.
 *     Financial and identity secret fills stay off this door entirely.
 *   - The 1-year standing-consent cap is enforced through the shared
 *     `assertAuthorizationExpiry`, not re-implemented.
 *   - No operation returns a secret. Enrol returns a vault item reference and a
 *     username; the password is never read here.
 */
export const BROWSER_CREDENTIALS_CLI_METHODS = {
  request: 'orchestrator_tools.browser_credentials.request',
  status: 'orchestrator_tools.browser_credentials.status',
  cancel: 'orchestrator_tools.browser_credentials.cancel',
  enrol: 'orchestrator_tools.browser_credentials.enrol',
  authorize: 'orchestrator_tools.browser_credentials.authorize',
  list: 'orchestrator_tools.browser_credentials.list',
  revoke: 'orchestrator_tools.browser_credentials.revoke',
} as const;

export type BrowserCredentialsCliMethod =
  typeof BROWSER_CREDENTIALS_CLI_METHODS[keyof typeof BROWSER_CREDENTIALS_CLI_METHODS];

export const BrowserCredentialsCliRequestPayloadSchema = BrowserRequestCredentialAccessSchema;
export const BrowserCredentialsCliLookupPayloadSchema = BrowserCredentialAccessLookupSchema;
export const BrowserCredentialsCliAccessResultSchema = BrowserGatewayResultSchema.safeExtend({
  data: BrowserApprovalRequestSchema.refine(
    (request) => Boolean(request.credentialAccess)
      && (request.status !== 'approved' || Boolean(request.credentialAccess?.authorizationId)),
    'Credential access decisions require actual credential authorization metadata',
  ).nullable().optional(),
}).superRefine((result, context) => {
  if (result.data && result.requestId && result.data.requestId !== result.requestId) {
    context.addIssue({ code: 'custom', message: 'Credential access request references must match' });
  }
});
export type BrowserCredentialsCliAccessResult = z.infer<typeof BrowserCredentialsCliAccessResultSchema>;

export const BrowserCredentialsCliEnrolPayloadSchema = BrowserEnrolCredentialRequestSchema;
export const BrowserCredentialsCliAuthorizePayloadSchema =
  BrowserCreateCredentialAuthorizationRequestSchema;
export const BrowserCredentialsCliListPayloadSchema =
  BrowserListCredentialAuthorizationsRequestSchema.optional().default({});
export const BrowserCredentialsCliRevokePayloadSchema =
  BrowserRevokeCredentialAuthorizationRequestSchema;

export const BrowserCredentialsCliEnrolResultSchema = z
  .object({
    vaultItemRef: z.string().min(1),
    username: z.string().min(1),
    movedIntoFolder: z.boolean(),
    /**
     * The origin as STORED, after normalisation. The CLI used to echo the raw
     * input, so `--origin https://Portal.Example.com/login` reported a string
     * that is not what the binding holds, which is the enrol/authorize
     * disagreement this module exists to prevent.
     */
    origin: z.string().min(1),
  })
  .strict();
export type BrowserCredentialsCliEnrolResult = z.infer<
  typeof BrowserCredentialsCliEnrolResultSchema
>;

/**
 * Mirrors `CredentialAuthorization`. `purposes` is wider than the create
 * payload's enum on purpose: a record minted through another surface may carry
 * `secret_fill`, and a read must not throw on it.
 */
export const BrowserCredentialsCliAuthorizationSchema = z
  .object({
    id: z.string().min(1),
    profileId: z.string().min(1),
    allowedOrigins: z.array(BrowserAuthorizationOriginSchema),
    purposes: z.array(
      z.enum(['login', 'register', 'totp', 'email_code', 'secret_fill']),
    ),
    allowedSecretTypes: z.array(z.string()).optional(),
    allowedSelectors: z.array(z.string()).optional(),
    allowedSenderDomains: z.array(z.string()).optional(),
    vaultFolder: z.string().min(1),
    createdAt: z.number(),
    expiresAt: z.number(),
    revokedAt: z.number().optional(),
    note: z.string().optional(),
    taskScope: z.string().min(1).optional(),
    vaultItemRef: z.string().min(1).optional(),
    computerId: z.string().min(1).optional(),
  })
  .strict();
export type BrowserCredentialsCliAuthorization = z.infer<
  typeof BrowserCredentialsCliAuthorizationSchema
>;

export const BrowserCredentialsCliAuthorizationListSchema = z.array(
  BrowserCredentialsCliAuthorizationSchema,
);

export const BrowserCredentialsCliRevokeResultSchema = z
  .object({ revoked: z.boolean() })
  .strict();

export type BrowserCredentialsCliEnrolInput = z.infer<
  typeof BrowserCredentialsCliEnrolPayloadSchema
>;
export type BrowserCredentialsCliAuthorizeInput = z.infer<
  typeof BrowserCredentialsCliAuthorizePayloadSchema
>;

/**
 * Main-process side of the CLI. Implemented over the same services the renderer
 * IPC handlers call, so there is one implementation and two doors.
 */
export interface BrowserCredentialsCliOperations {
  enrol(input: BrowserCredentialsCliEnrolInput): Promise<BrowserCredentialsCliEnrolResult>;
  authorize(
    input: BrowserCredentialsCliAuthorizeInput,
  ): Promise<BrowserCredentialsCliAuthorization>;
  list(profileId?: string): Promise<BrowserCredentialsCliAuthorization[]>;
  revoke(authorizationId: string): Promise<{ revoked: boolean }>;
}
