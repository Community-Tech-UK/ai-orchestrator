/**
 * Zod schemas for provider account pools (Claude Code, Codex CLI and
 * OpenCode/MiMo): the two settings keys and the `provider-account:*` IPC
 * surface.
 *
 * Mirrors `copilot-account.schemas.ts`. The properties that matter:
 *
 * 1. A profile ID becomes a directory name on every execution node, so it is a
 *    strict safe slug.
 * 2. A profile is legacy exactly when its ID is `legacy`; the legacy profile is
 *    bound to `~/.claude` / `~/.codex` and every other profile to a derived home.
 *    OpenCode/MiMo keeps no per-account home: its profile carries the Token
 *    Plan `region` that derives its OpenCode provider name instead.
 * 3. No payload can name a path, an environment map or a credential body.
 */

import { z } from 'zod';

/** Keep in sync with `PROVIDER_ACCOUNT_PROFILE_ID_PATTERN` in
 *  src/shared/types/provider-account.types.ts. */
export const ProviderAccountProfileIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Profile ID must be a lowercase safe slug');

export const PooledProviderSchema = z.enum(['claude', 'codex', 'opencode']);
export const OpenCodeAccountRegionSchema = z.enum(['ams', 'sgp', 'cn']);
export const AccountAutomationPolicySchema = z.enum(['allow-routed', 'manual-only', 'disabled']);
export const AccountFailoverModeSchema = z.enum(['automatic', 'ask', 'off']);
export const AccountContinuationModeSchema = z.enum(['shared-store', 'replay']);

export const MAX_PROFILES_PER_PROVIDER = 8;
const LEGACY_PROFILE_ID = 'legacy';

const timestampSchema = z.number().finite().int().min(0);
const labelSchema = z.string().trim().min(1).max(64);
/** Verified identity as the CLI reports it (normally an email). Bounded, never a token. */
export const AccountIdentitySchema = z.string().trim().min(1).max(320);
const accountKeySchema = z.string().trim().min(1).max(128);
const planLabelSchema = z.string().trim().min(1).max(64);
/** Chrome profile folder name ("Default", "Profile 1"): no separators, never a path.
 *  Keep in sync with `ACCOUNT_CHROME_PROFILE_PATTERN` in
 *  src/shared/types/provider-account.types.ts. */
export const AccountChromeProfileSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/, 'Chrome profile must be a plain folder name');

export const ProviderAccountProfileSchema = z
  .object({
    id: ProviderAccountProfileIdSchema,
    provider: PooledProviderSchema,
    label: labelSchema,
    expectedIdentity: z.union([AccountIdentitySchema, z.null()]),
    expectedAccountKey: z.union([accountKeySchema, z.null()]),
    planLabel: z.union([planLabelSchema, z.null()]),
    priority: z.number().int().min(0).max(1000),
    enabled: z.boolean(),
    automationPolicy: AccountAutomationPolicySchema,
    isLegacy: z.boolean(),
    /** OpenCode/MiMo only and required there: picks the derived provider name. */
    region: OpenCodeAccountRegionSchema.optional(),
    /** OpenCode/MiMo only and optional: Chrome profile for per-account allowance. */
    chromeProfile: AccountChromeProfileSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine(
    (profile) => profile.isLegacy === (profile.id === LEGACY_PROFILE_ID),
    'A profile is legacy exactly when its ID is "legacy"',
  )
  .refine(
    (profile) => (profile.provider === 'opencode') === (profile.region !== undefined),
    'region belongs to OpenCode/MiMo profiles only, and is required for them',
  )
  .refine(
    (profile) => profile.chromeProfile === undefined || profile.provider === 'opencode',
    'chromeProfile belongs to OpenCode/MiMo profiles only',
  );

export const ProviderAccountProfilesSchema = z
  .array(ProviderAccountProfileSchema)
  .max(MAX_PROFILES_PER_PROVIDER * 3)
  .superRefine((profiles, context) => {
    const keys = new Set<string>();
    const priorities = new Set<string>();
    const counts = new Map<string, number>();
    for (const profile of profiles) {
      // IDs are unique per provider: `legacy` exists once per pooled provider.
      const key = `${profile.provider}:${profile.id}`;
      if (keys.has(key)) {
        context.addIssue({ code: 'custom', message: `Duplicate profile ID: ${key}` });
      }
      keys.add(key);
      const priorityKey = `${profile.provider}:${profile.priority}`;
      if (priorities.has(priorityKey)) {
        context.addIssue({ code: 'custom', message: `Duplicate ${profile.provider} priority: ${profile.priority}` });
      }
      priorities.add(priorityKey);
      const count = (counts.get(profile.provider) ?? 0) + 1;
      counts.set(profile.provider, count);
      if (count > MAX_PROFILES_PER_PROVIDER) {
        context.addIssue({
          code: 'custom',
          message: `At most ${MAX_PROFILES_PER_PROVIDER} ${profile.provider} account profiles are allowed`,
        });
      }
    }
  });

export const AccountPreemptivePolicySchema = z
  .object({
    newSessions: z.boolean(),
    liveSessionsAtTurnBoundary: z.boolean(),
    thresholdPct: z.number().int().min(1).max(100),
  })
  .strict();

export const ProviderAccountPoolPolicySchema = z
  .object({
    failoverMode: AccountFailoverModeSchema,
    continuation: AccountContinuationModeSchema,
    preemptive: AccountPreemptivePolicySchema,
    switchCooldownMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
    maxSwitchesPerTurn: z.number().int().min(0).max(MAX_PROFILES_PER_PROVIDER - 1),
    acknowledgedOwnershipAt: z.union([timestampSchema, z.null()]),
  })
  .strict();

export const ProviderAccountPoolsSchema = z
  .object({
    claude: ProviderAccountPoolPolicySchema,
    codex: ProviderAccountPoolPolicySchema,
    opencode: ProviderAccountPoolPolicySchema,
  })
  .strict();

export type ProviderAccountProfileInput = z.infer<typeof ProviderAccountProfileSchema>;
export type ProviderAccountPoolPolicyInput = z.infer<typeof ProviderAccountPoolPolicySchema>;

// ============ IPC payloads ============

/**
 * The preload bridge stamps every authenticated invoke with `ipcAuthToken`, so
 * every `.strict()` payload must declare it or reject each real renderer call
 * (LT-522). It is accepted and ignored: main authorises from the sender.
 */
const ipcAuthTokenField = { ipcAuthToken: z.string().optional() };

const profileRefShape = {
  ...ipcAuthTokenField,
  provider: PooledProviderSchema,
  profileId: ProviderAccountProfileIdSchema,
};

export const ProviderAccountProviderPayloadSchema = z
  .object({ ...ipcAuthTokenField, provider: PooledProviderSchema.optional() })
  .strict()
  .or(z.undefined());

export const ProviderAccountCreatePayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    provider: PooledProviderSchema,
    label: labelSchema,
    automationPolicy: AccountAutomationPolicySchema.optional(),
    /** OpenCode/MiMo only and required there (Token Plan region). */
    region: OpenCodeAccountRegionSchema.optional(),
    chromeProfile: AccountChromeProfileSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.provider === 'opencode') === (value.region !== undefined),
    'region is required for OpenCode/MiMo accounts and forbidden for others',
  )
  .refine(
    (value) => value.chromeProfile === undefined || value.provider === 'opencode',
    'chromeProfile belongs to OpenCode/MiMo accounts only',
  );

export const ProviderAccountRefPayloadSchema = z.object(profileRefShape).strict();

/** Default copies the sign-in command; `openTerminal` also opens a Harness terminal. */
export const ProviderAccountLaunchLoginPayloadSchema = z
  .object({
    ...profileRefShape,
    openTerminal: z.boolean().optional(),
  })
  .strict();

export const ProviderAccountUpdatePayloadSchema = z
  .object({
    ...profileRefShape,
    label: labelSchema.optional(),
    enabled: z.boolean().optional(),
    automationPolicy: AccountAutomationPolicySchema.optional(),
    /** OpenCode/MiMo only: retarget the per-account allowance read (Decision 8).
     *  `null` removes the explicit association; added accounts then have no allowance reader. */
    chromeProfile: z.union([AccountChromeProfileSchema, z.null()]).optional(),
    /** Adopt the identity the binding check observed. */
    adoptObservedIdentity: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.label !== undefined
      || value.enabled !== undefined
      || value.automationPolicy !== undefined
      || value.chromeProfile !== undefined
      || value.adoptObservedIdentity !== undefined,
    'Provide at least one field to change',
  )
  .refine(
    (value) => value.chromeProfile === undefined || value.provider === 'opencode',
    'chromeProfile belongs to OpenCode/MiMo accounts only',
  );

export const ProviderAccountSetPriorityOrderPayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    provider: PooledProviderSchema,
    profileIds: z.array(ProviderAccountProfileIdSchema).min(1).max(MAX_PROFILES_PER_PROVIDER),
  })
  .strict();

export const ProviderAccountPoolUpdatePayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    provider: PooledProviderSchema,
    failoverMode: AccountFailoverModeSchema.optional(),
    continuation: AccountContinuationModeSchema.optional(),
    preemptive: AccountPreemptivePolicySchema.partial().strict().optional(),
    switchCooldownMs: ProviderAccountPoolPolicySchema.shape.switchCooldownMs.optional(),
    maxSwitchesPerTurn: ProviderAccountPoolPolicySchema.shape.maxSwitchesPerTurn.optional(),
  })
  .strict();

export const ProviderAccountAcknowledgePayloadSchema = z
  .object({ ...ipcAuthTokenField, provider: PooledProviderSchema, acknowledged: z.literal(true) })
  .strict();

export const ProviderAccountResolvePreviewPayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    provider: PooledProviderSchema,
    model: z.string().trim().min(1).max(200).optional(),
    explicitProfileId: ProviderAccountProfileIdSchema.optional(),
    /** The worker node the draft targets; omitted for this machine. */
    executionNodeId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const ProviderAccountSwitchSessionPayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    instanceId: z.string().min(1).max(200),
    profileId: ProviderAccountProfileIdSchema,
    /** The user confirmed the conversation continues on the other account. */
    confirmed: z.literal(true),
  })
  .strict();

export const ProviderAccountDoctorPayloadSchema = z
  .object({ ...ipcAuthTokenField, provider: PooledProviderSchema })
  .strict();
