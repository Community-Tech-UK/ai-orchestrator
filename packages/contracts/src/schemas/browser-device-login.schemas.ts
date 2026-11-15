import type { BrowserApprovalRequest } from '../types/browser.types';
import { z } from 'zod';

const id = z.string().min(1).max(200);
/** Non-secret bindings supplied by the authenticated native and browser owners. */
export const BrowserDeviceLoginMetadataSchema = z.object({
  operationHandle: id,
  ownerSessionId: id,
  ownerGeneration: id,
  nativeNodeId: id,
  nativeProfileId: id,
  nativeComputerName: z.string().min(1).max(500),
  browserNodeId: id,
  browserProfileId: id,
  browserComputerName: z.string().min(1).max(500),
  targetId: id,
  origin: z.literal('https://auth.openai.com'),
  expectedIdentity: z.string().email().max(320),
  extensionInstanceId: id,
  extensionGeneration: id,
  documentId: id,
  expiresAt: z.number().int().positive(),
  sessionName: z.string().min(1).max(500).optional(),
}).strict();

export const BrowserDeviceLoginChoiceSchema = z.object({ permission: z.literal('operation') }).strict();

/** Device consent cannot masquerade as a vault approval or broader browser grant. */
export function validateDeviceLoginApproval(value: BrowserApprovalRequest, ctx: z.RefinementCtx): void {
  if (value.deviceLogin) {
    const device = value.deviceLogin;
    const grant = value.proposedGrant;
    if (value.credentialAccess || value.grantId || value.instanceId !== device.ownerSessionId ||
      value.profileId !== device.browserProfileId || value.targetId !== device.targetId ||
      value.origin !== device.origin || value.expiresAt !== device.expiresAt ||
      value.toolName !== 'browser.fill_device_login' || value.action !== 'fill_device_login' || value.actionClass !== 'credential' ||
      value.url && value.url !== device.origin || value.selector || value.elementContext || value.filePath || value.detectedFileType ||
      grant.mode !== 'per_action' || grant.autonomous || grant.allowExternalNavigation || grant.uploadRoots ||
      grant.nodeId && grant.nodeId !== device.browserNodeId ||
      grant.allowedActionClasses.length !== 1 || grant.allowedActionClasses[0] !== 'credential' ||
      grant.allowedOrigins.length !== 1 || grant.allowedOrigins[0].scheme !== 'https' ||
      grant.allowedOrigins[0].hostPattern !== 'auth.openai.com' || grant.allowedOrigins[0].includeSubdomains || grant.allowedOrigins[0].port) {
      ctx.addIssue({ code: 'custom', message: 'Device sign-in approval must match exactly one operation and its browser destination.' });
    }
  }
}
