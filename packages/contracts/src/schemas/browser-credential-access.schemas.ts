import { z } from 'zod';

const id = z.string().trim().min(1).max(200);
const purpose = z.enum(['login', 'totp']);
export const MAX_REMEMBER_CREDENTIAL_ACCESS_MS = 7 * 86_400_000;
export const TASK_CREDENTIAL_ACCESS_MS = 8 * 60 * 60 * 1000;

export const BrowserRequestCredentialAccessSchema = z.object({
  profileId: id,
  targetId: id,
  item: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
  purposes: z.array(purpose).min(1).max(2).optional(),
}).strict();

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
  purposes: z.array(purpose).min(1).max(2),
  permission: z.enum(['task', 'remember']),
  permissionExpiresAt: z.number().int().positive().optional(),
  authorizationId: id.optional(),
  operationError: z.string().min(1).max(200).optional(),
}).strict();
