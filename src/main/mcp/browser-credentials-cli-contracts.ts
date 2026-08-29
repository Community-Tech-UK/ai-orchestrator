import { z } from 'zod';
import {
  BrowserAuthorizationOriginSchema,
  BrowserCreateCredentialAuthorizationRequestSchema,
  BrowserEnrolCredentialRequestSchema,
  BrowserListCredentialAuthorizationsRequestSchema,
  BrowserRevokeCredentialAuthorizationRequestSchema,
} from '@contracts/schemas/browser-unattended';

/**
 * Contract for `aio-mcp browser-credentials`: bind an existing vault login to
 * an origin, and mint/list/revoke the standing authorizations that let an
 * unattended fill use it.
 *
 * 2026-08-29 DELIBERATE WIDENING, authorised by the operator (James).
 *
 * These two operations were renderer-only by explicit decision. The schema file
 * this imports from still carries the original wording, and
 * `BrowserEnrolCredentialRequestSchema` said in terms that "an agent must never
 * enrol its own credential". That rule was documented, not enforced, and the
 * operator has now overruled it: requiring a human at a GUI for every portal
 * login was the single thing preventing unattended operation, and every stalled
 * task in that class had been an authentication step rather than an approval
 * step.
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
  enrol: 'orchestrator_tools.browser_credentials.enrol',
  authorize: 'orchestrator_tools.browser_credentials.authorize',
  list: 'orchestrator_tools.browser_credentials.list',
  revoke: 'orchestrator_tools.browser_credentials.revoke',
} as const;

export type BrowserCredentialsCliMethod =
  typeof BROWSER_CREDENTIALS_CLI_METHODS[keyof typeof BROWSER_CREDENTIALS_CLI_METHODS];

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
