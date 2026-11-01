import { z } from 'zod';

const id = z.string().trim().min(1).max(200);
const purpose = z.enum(['login', 'totp', 'email_code']);
/**
 * A domain that sends this website's emailed sign-in codes when it is not the
 * website's own (British Council MyProcurement on tap.tcsapps.com mails from
 * britishcouncil.org). The person approving sees and grants each one.
 */
const senderDomain = z.string().trim().toLowerCase().min(3).max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/);
const senderDomains = z.array(senderDomain).min(1).max(5);
/**
 * Explicit "remember" consent is long-lived but never indefinite. One year
 * matches MAX_AUTHORIZATION_LIFETIME_MS in
 * src/main/browser-gateway/browser-credential-authorization-store.ts, the
 * standing-consent cap shared by every authorization door; keeping the two
 * equal means the card can never mint a lifetime the standing policy refuses.
 */
export const MAX_REMEMBER_CREDENTIAL_ACCESS_MS = 365 * 86_400_000;
export const TASK_CREDENTIAL_ACCESS_MS = 8 * 60 * 60 * 1000;

export const BrowserRequestCredentialAccessSchema = z.object({
  profileId: id,
  targetId: id,
  item: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
  purposes: z.array(purpose).min(1).max(3).optional(),
  senderDomains: senderDomains.optional(),
}).strict().refine((input) => !input.senderDomains || input.purposes?.includes('email_code'), {
  message: 'senderDomains apply only to the email_code purpose',
  path: ['senderDomains'],
});

export const BrowserCredentialAccessLookupSchema = z.object({ requestId: id }).strict();

export const BrowserCredentialAccessChoiceSchema = z.discriminatedUnion('permission', [
  z.object({ permission: z.literal('task') }).strict(),
  z.object({
    permission: z.literal('remember'),
    rememberForMs: z.number().int().min(60_000).max(MAX_REMEMBER_CREDENTIAL_ACCESS_MS),
  }).strict(),
]);

export const BrowserCredentialAccessMetadataSchema = z.object({
  taskScope: id,
  sessionName: z.string().min(1).max(500),
  reason: z.string().min(1).max(1000),
  origin: z.string().url().max(2000),
  computerName: z.string().min(1).max(500),
  computerId: id,
  scope: id,
  vaultItemRef: id,
  itemTitle: z.string().min(1).max(500),
  vaultFolder: z.string().min(1).max(500),
  moveIntoFolder: z.boolean(),
  purposes: z.array(purpose).min(1).max(3),
  senderDomains: senderDomains.optional(),
  permission: z.enum(['task', 'remember']),
  permissionExpiresAt: z.number().int().positive().optional(),
  authorizationId: id.optional(),
  operationError: z.string().min(1).max(200).optional(),
}).strict();
