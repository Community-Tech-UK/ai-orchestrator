import type { BrowserApprovalRequest } from '../types/browser.types';
import { z } from 'zod';

const id = z.string().min(1).max(200);
const recoveryId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
/** An exact http(s) origin, as the extension stores protected origins. */
const exactOrigin = z.string().max(2000).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}, 'Expected an exact http(s) origin');

export const BrowserRecoverSecretObservationRequestSchema = z.object({
  profileId: id,
  targetId: id,
  reason: z.string().min(1).max(1000).optional(),
  requestId: id.optional(),
}).strict();

export const BrowserSecretRecoveryMetadataSchema = z.object({
  operationId: z.uuid(),
  ownerSessionId: id,
  nodeId: id,
  computerName: z.string().min(1).max(500),
  extensionInstanceId: id.optional(),
  targetId: id,
  origins: z.array(exactOrigin).min(1).max(16)
    .refine((origins) => origins.every((origin, index) => index === 0 || origins[index - 1] < origin),
      'Origins must be sorted and unique'),
  affectedTabCount: z.number().int().min(0).max(100_000),
  writeGeneration: recoveryId,
  expiresAt: z.number().int().positive(),
}).strict();

export const BrowserSecretRecoveryProgressSchema = z.object({
  state: z.enum(['running', 'recovered', 'stale_review', 'manual_security_review_required', 'failed', 'indeterminate']),
  reasonCode: z.string().regex(/^[a-z0-9_:.-]{1,200}$/),
  loginVerified: z.boolean().nullable(),
  clearedTabCount: z.number().int().min(0).max(100_000).optional(),
  receiptId: z.uuid().optional(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const BrowserSecretRecoveryChoiceSchema = z.object({ permission: z.literal('operation') }).strict();

/** Recovery consent cannot masquerade as a grant, a vault approval or a device sign-in. */
export function validateSecretRecoveryApproval(value: BrowserApprovalRequest, ctx: z.RefinementCtx): void {
  const recovery = value.secretRecovery;
  if (!recovery) {
    if (value.secretRecoveryProgress) {
      ctx.addIssue({ code: 'custom', message: 'Recovery progress needs its recovery approval.' });
    }
    return;
  }
  const grant = value.proposedGrant;
  if (value.credentialAccess || value.deviceLogin || value.grantId || value.instanceId !== recovery.ownerSessionId
    || value.targetId !== recovery.targetId || value.origin !== recovery.origins[0]
    || value.expiresAt !== recovery.expiresAt || value.toolName !== 'browser.recover_secret_observation'
    || value.action !== 'recover_secret_observation' || value.actionClass !== 'credential'
    || value.url || value.selector || value.elementContext || value.filePath || value.detectedFileType
    || grant.mode !== 'per_action' || grant.autonomous || grant.allowExternalNavigation || grant.uploadRoots
    || grant.allowedActionClasses.length !== 1 || grant.allowedActionClasses[0] !== 'read'
    || grant.allowedOrigins.length !== recovery.origins.length) {
    ctx.addIssue({ code: 'custom', message: 'Secret recovery approval must match exactly one reviewed recovery.' });
  }
}
