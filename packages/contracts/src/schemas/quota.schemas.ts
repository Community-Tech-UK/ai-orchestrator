import { z } from 'zod';

/**
 * Provider Quota — IPC payload schemas.
 *
 * NOTE: The runtime types for snapshots/windows live in
 * `src/shared/types/provider-quota.types.ts`. These schemas validate only the
 * inputs that cross the IPC boundary — the service emits typed snapshots to
 * the renderer, but those don't need re-validation on the way out.
 */

// Locally scoped — matches the pattern in session.schemas.ts so we don't have
// to plumb a new export through @contracts/schemas/common.
const IpcAuthTokenSchema = z.string().max(500).optional();

export const ProviderIdSchema = z.enum(['claude', 'codex', 'gemini', 'copilot']);

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
