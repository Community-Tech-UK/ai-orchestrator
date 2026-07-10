import { z } from 'zod';

const appIdSchema = z.string().trim().min(1).max(512);
const windowIdSchema = z.string().trim().min(1).max(512);
const boundedTextSchema = z.string().trim().min(1).max(2000);
const typedTextSchema = z.string().min(1).max(2000);
const observationTokenSchema = z.string().trim().min(1).max(256);
const elementUidSchema = z.string().trim().min(1).max(512);

const DesktopRegionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive().max(20_000),
  height: z.number().finite().positive().max(20_000),
}).strict();

const DesktopPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();

const DesktopInputBaseSchema = z.object({
  appId: appIdSchema,
  observationToken: observationTokenSchema,
  sensitive: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const DesktopHealthRequestSchema = z.object({}).strict();

export const DesktopListAppsRequestSchema = z.object({
  includeDeniedMetadata: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();

export const DesktopRequestAppGrantSchema = z.object({
  appId: appIdSchema,
  capability: z.enum(['observe', 'input', 'observeAndInput']),
  reason: boundedTextSchema,
  duration: z.enum(['session', 'untilRevoked', 'boundedMinutes']),
  minutes: z.number().int().min(1).max(24 * 60).optional(),
}).strict();

export const DesktopApprovalStatusRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(256),
}).strict();

export const DesktopScreenshotRequestSchema = z.object({
  appId: appIdSchema,
  windowId: windowIdSchema.optional(),
  region: DesktopRegionSchema.optional(),
  scale: z.number().finite().positive().max(4).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const DesktopAccessibilitySnapshotRequestSchema = z.object({
  appId: appIdSchema,
  windowId: windowIdSchema.optional(),
  maxNodes: z.number().int().min(1).max(2000).optional(),
  includeBounds: z.boolean().optional(),
  roleFilters: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
}).strict();

export const DesktopClickRequestSchema = DesktopInputBaseSchema.extend({
  elementUid: elementUidSchema.optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  button: z.enum(['left', 'middle', 'right']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
}).refine((value) => value.elementUid || (value.x !== undefined && value.y !== undefined), {
  message: 'Click requires elementUid or x/y coordinates',
});

export const DesktopTypeTextRequestSchema = DesktopInputBaseSchema.extend({
  text: typedTextSchema,
  elementUid: elementUidSchema.optional(),
});

export const DesktopHotkeyRequestSchema = DesktopInputBaseSchema.extend({
  keys: z.array(z.string().trim().min(1).max(64)).min(1).max(8),
});

export const DesktopScrollRequestSchema = DesktopInputBaseSchema.extend({
  direction: z.enum(['up', 'down', 'left', 'right']),
  amount: z.number().int().min(1).max(20),
  elementUid: elementUidSchema.optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
});

export const DesktopDragRequestSchema = DesktopInputBaseSchema.extend({
  start: DesktopPointSchema,
  end: DesktopPointSchema,
  durationMs: z.number().int().min(0).max(10_000).optional(),
});

export const DesktopWaitForRequestSchema = z.object({
  appId: appIdSchema,
  condition: z.object({
    text: z.string().trim().min(1).max(500).optional(),
    role: z.string().trim().min(1).max(128).optional(),
    label: z.string().trim().min(1).max(500).optional(),
  }).strict().refine((value) => value.text || value.role || value.label, {
    message: 'wait_for condition requires text, role, or label',
  }),
  timeoutMs: z.number().int().min(1).max(30_000).optional(),
}).strict();

export const DesktopQueryElementsRequestSchema = z.object({
  observationToken: observationTokenSchema,
  appId: appIdSchema.optional(),
  text: z.string().trim().min(1).max(500).optional(),
  role: z.string().trim().min(1).max(128).optional(),
  label: z.string().trim().min(1).max(500).optional(),
  value: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const DesktopListGrantsRequestSchema = z.object({
  appId: appIdSchema.optional(),
  includeExpired: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const DesktopRevokeGrantRequestSchema = z.object({
  grantId: z.string().trim().min(1).max(256),
  reason: boundedTextSchema.optional(),
}).strict();

export const DesktopAuditLogRequestSchema = z.object({
  appId: appIdSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const DesktopRaiseEscalationRequestSchema = z.object({
  appId: appIdSchema.optional(),
  kind: z.enum([
    'login',
    'captcha',
    'two_factor',
    'credential_request',
    'payment',
    'admin_prompt',
    'destructive_action',
    'unknown_modal',
    'wrong_app',
    'other',
  ]),
  reason: boundedTextSchema,
}).strict();
