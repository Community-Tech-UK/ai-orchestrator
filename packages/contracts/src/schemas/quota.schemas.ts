import { z } from 'zod';

/**
 * Provider Quota — IPC payload schemas.
 *
 * NOTE: The runtime types for snapshots/windows live in
 * `src/shared/types/provider-quota.types.ts`. These schemas cover both request
 * payloads and the main-to-renderer events emitted by the quota service.
 */

// Locally scoped — matches the pattern in session.schemas.ts so we don't have
// to plumb a new export through @contracts/schemas/common.
const IpcAuthTokenSchema = z.string().max(500).optional();

export const ProviderIdSchema = z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok']);

export const QuotaGetAllPayloadSchema = z
  .object({
    ipcAuthToken: IpcAuthTokenSchema,
  })
  .optional();

export const QuotaGetProviderPayloadSchema = z.object({
  provider: ProviderIdSchema,
  ipcAuthToken: IpcAuthTokenSchema,
});

export const QuotaRefreshPayloadSchema = z.object({
  provider: ProviderIdSchema,
  ipcAuthToken: IpcAuthTokenSchema,
});

export const QuotaRefreshAllPayloadSchema = z
  .object({
    ipcAuthToken: IpcAuthTokenSchema,
  })
  .optional();

export const QuotaSetPollIntervalPayloadSchema = z.object({
  provider: ProviderIdSchema,
  /** 0 disables polling. Cap at 1 day to keep timers sane. */
  intervalMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000),
  ipcAuthToken: IpcAuthTokenSchema,
});

export const ProviderQuotaWindowSchema = z.object({
  kind: z.enum(['rolling-window', 'calendar-period', 'rate-limit', 'context-window']),
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  unit: z.enum(['requests', 'messages', 'tokens', 'usd']),
  used: z.number().nonnegative(),
  limit: z.number().nonnegative(),
  remaining: z.union([z.number(), z.nan()]),
  resetsAt: z.number().int().nonnegative().nullable(),
}).strict();

export const ProviderQuotaSnapshotEventSchema = z.object({
  provider: ProviderIdSchema,
  takenAt: z.number().int().nonnegative(),
  source: z.enum(['header', 'slash-command', 'cli-result', 'admin-api', 'inferred']),
  ok: z.boolean(),
  error: z.string().max(10_000).optional(),
  needsReauth: z.boolean().optional(),
  cliNotInstalled: z.boolean().optional(),
  windows: z.array(ProviderQuotaWindowSchema).max(100),
  plan: z.string().max(200).optional(),
}).strict();

export const ProviderQuotaAlertEventSchema = z.object({
  provider: ProviderIdSchema,
  window: ProviderQuotaWindowSchema,
  threshold: z.union([z.literal(50), z.literal(75), z.literal(90), z.literal(100)]),
  timestamp: z.number().int().nonnegative(),
}).strict();

export const ProviderQuotaPacingAlertEventSchema = z.object({
  provider: ProviderIdSchema,
  window: ProviderQuotaWindowSchema,
  utilizationPercent: z.number().nonnegative().finite(),
  elapsedPercent: z.number().nonnegative().finite(),
  utilizationThresholdPercent: z.number().nonnegative().finite(),
  latestElapsedPercent: z.number().nonnegative().finite(),
  timestamp: z.number().int().nonnegative(),
}).strict();
