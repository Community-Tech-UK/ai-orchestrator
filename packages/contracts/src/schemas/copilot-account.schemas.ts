/**
 * Zod schemas for GitHub Copilot account profiles, routing rules, and the
 * routing IPC surface.
 *
 * Two properties matter more than convenience here:
 *
 * 1. A profile ID becomes a directory name on every execution node, so it is a
 *    strict safe slug — not a free-form string that the home resolver later has
 *    to defend against.
 * 2. Hosts are validated as exact lowercase hostnames. Substring host matching
 *    (`host.includes('github.com')`) is what makes `github.com.evil.example`
 *    look like GitHub; routing decides which *account* services a repository,
 *    so a near-miss host must not match.
 */

import { z } from 'zod';

/** Profile IDs become directory names. Keep this in sync with
 *  `COPILOT_PROFILE_ID_PATTERN` in src/shared/types/copilot-account.types.ts. */
export const CopilotProfileIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Profile ID must be a lowercase safe slug');

export const CopilotRuleIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Rule ID must be a lowercase safe slug');

/**
 * Exact hostname: lowercase labels separated by dots, no scheme, no port, no
 * path, no userinfo, no trailing dot. Rejects uppercase input rather than
 * silently folding it, so callers normalize before they persist.
 */
export const CopilotHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/,
    'Host must be an exact lowercase hostname',
  );

/** GitHub login/owner segment. GitHub allows alphanumerics and single hyphens. */
export const CopilotOwnerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/, 'Owner must be a lowercase GitHub login');

/** Repository name segment, `.git` already stripped. */
export const CopilotRepoSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9._-]+$/, 'Repository must be a lowercase repository name');

export const CopilotAccountScopePolicySchema = z.enum(['matched-only', 'default-eligible']);
export const CopilotAutomationPolicySchema = z.enum(['allow-routed', 'manual-only', 'disabled']);
export const CopilotAccountKindSchema = z.enum(['personal', 'enterprise']);

const timestampSchema = z.number().finite().int().min(0);

export const CopilotAccountProfileSchema = z
  .object({
    id: CopilotProfileIdSchema,
    label: z.string().trim().min(1).max(64),
    expectedLogin: z.union([CopilotOwnerSchema, z.null()]),
    host: CopilotHostSchema,
    accountKind: CopilotAccountKindSchema,
    scopePolicy: CopilotAccountScopePolicySchema,
    automationPolicy: CopilotAutomationPolicySchema,
    isDefault: z.boolean(),
    isLegacy: z.boolean().optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

/**
 * Canonical absolute path for a path-prefix rule. Rejects relative paths,
 * traversal segments, and null bytes at the schema boundary so a rule can never
 * carry `..` into the path-containment comparison.
 */
export const CopilotCanonicalPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'Path must not contain a null byte')
  .refine(
    (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value),
    'Path must be absolute',
  )
  .refine(
    (value) => !value.split(/[\\/]+/).includes('..'),
    'Path must not contain traversal segments',
  );

export const CopilotRoutingMatcherSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('repository'),
      host: CopilotHostSchema,
      owner: CopilotOwnerSchema,
      repo: CopilotRepoSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('owner'),
      host: CopilotHostSchema,
      owner: CopilotOwnerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('path-prefix'),
      canonicalPath: CopilotCanonicalPathSchema,
    })
    .strict(),
]);

export const CopilotAccountRoutingRuleSchema = z
  .object({
    id: CopilotRuleIdSchema,
    profileId: CopilotProfileIdSchema,
    matcher: CopilotRoutingMatcherSchema,
    isProtected: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const MAX_COPILOT_PROFILES = 16;
export const MAX_COPILOT_RULES = 500;

/**
 * Stable key for a matcher, used to detect two rules with an identical matcher.
 * Path comparison is exact here — normalization/case-folding happens in the
 * resolver, which knows the platform.
 */
export function copilotMatcherKey(matcher: z.infer<typeof CopilotRoutingMatcherSchema>): string {
  switch (matcher.type) {
    case 'repository':
      return `repository:${matcher.host}/${matcher.owner}/${matcher.repo}`;
    case 'owner':
      return `owner:${matcher.host}/${matcher.owner}`;
    case 'path-prefix':
      return `path-prefix:${matcher.canonicalPath}`;
  }
}

export const CopilotAccountProfilesSchema = z
  .array(CopilotAccountProfileSchema)
  .max(MAX_COPILOT_PROFILES)
  .superRefine((profiles, context) => {
    const ids = new Set<string>();
    let defaults = 0;
    for (const profile of profiles) {
      if (ids.has(profile.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate profile ID: ${profile.id}`,
        });
      }
      ids.add(profile.id);
      if (profile.isDefault) {
        defaults += 1;
        if (profile.scopePolicy !== 'default-eligible') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Default profile ${profile.id} must be default-eligible`,
          });
        }
      }
    }
    if (defaults > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At most one Copilot account profile may be the default',
      });
    }
  });

export const CopilotAccountRoutingRulesSchema = z
  .array(CopilotAccountRoutingRuleSchema)
  .max(MAX_COPILOT_RULES)
  .superRefine((rules, context) => {
    const ids = new Set<string>();
    const matchers = new Set<string>();
    for (const rule of rules) {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate rule ID: ${rule.id}`,
        });
      }
      ids.add(rule.id);
      const key = copilotMatcherKey(rule.matcher);
      if (matchers.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate routing matcher: ${key}`,
        });
      }
      matchers.add(key);
    }
  });

/**
 * Cross-field validation that spans both settings keys. The individual settings
 * schemas cannot see each other, so `assertCopilotRoutingConsistency` is called
 * by the routing service and the IPC handlers whenever both are in hand — a
 * rule pointing at a deleted profile must never silently route nowhere.
 */
export function assertCopilotRoutingConsistency(
  profiles: z.infer<typeof CopilotAccountProfilesSchema>,
  rules: z.infer<typeof CopilotAccountRoutingRulesSchema>,
): void {
  const ids = new Set(profiles.map((profile) => profile.id));
  for (const rule of rules) {
    if (!ids.has(rule.profileId)) {
      throw new Error(`Routing rule ${rule.id} references unknown profile ${rule.profileId}`);
    }
  }
}

export type CopilotAccountProfileInput = z.infer<typeof CopilotAccountProfileSchema>;
export type CopilotAccountRoutingRuleInput = z.infer<typeof CopilotAccountRoutingRuleSchema>;
export type CopilotRoutingMatcherInput = z.infer<typeof CopilotRoutingMatcherSchema>;

// ============ IPC payloads ============

/**
 * Every payload below carries bounded, non-secret metadata only. Note what is
 * absent by design: no filesystem path, no environment map, no config body.
 * A profile home is derived in main from `profileId`; nothing here can name a
 * directory.
 */

/**
 * The preload bridge stamps every authenticated invoke with `ipcAuthToken`
 * (`withAuth()` in `src/preload/preload.ts`), so a `.strict()` payload schema
 * must declare it or reject every real renderer call before a handler ever
 * runs. It is accepted and then ignored: main authorises from the sender via
 * `ensureTrustedSender`, never from this value, and no store here spreads a
 * payload into a persisted record. Same convention as `provider.schemas.ts`
 * and `voice.schemas.ts`.
 */
const ipcAuthTokenField = { ipcAuthToken: z.string().optional() };

export const CopilotAccountCreatePayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    label: z.string().trim().min(1).max(64),
    accountKind: CopilotAccountKindSchema,
    host: CopilotHostSchema.optional(),
    scopePolicy: CopilotAccountScopePolicySchema.optional(),
    automationPolicy: CopilotAutomationPolicySchema.optional(),
    makeDefault: z.boolean().optional(),
  })
  .strict();

export const CopilotAccountIdPayloadSchema = z
  .object({ ...ipcAuthTokenField, profileId: CopilotProfileIdSchema })
  .strict();

export const CopilotAccountRenamePayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    profileId: CopilotProfileIdSchema,
    label: z.string().trim().min(1).max(64),
  })
  .strict();

export const CopilotAccountUpdatePolicyPayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    profileId: CopilotProfileIdSchema,
    scopePolicy: CopilotAccountScopePolicySchema.optional(),
    automationPolicy: CopilotAutomationPolicySchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.scopePolicy !== undefined || value.automationPolicy !== undefined,
    'Provide at least one policy to change',
  );

export const CopilotAccountAdoptIdentityPayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    profileId: CopilotProfileIdSchema,
    login: CopilotOwnerSchema,
    host: CopilotHostSchema.optional(),
  })
  .strict();

export const CopilotAccountRuleCreatePayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    profileId: CopilotProfileIdSchema,
    matcher: CopilotRoutingMatcherSchema,
    isProtected: z.boolean().optional(),
  })
  .strict();

export const CopilotAccountRuleIdPayloadSchema = z
  .object({ ...ipcAuthTokenField, ruleId: CopilotRuleIdSchema })
  .strict();

/**
 * Route preview. `workingDirectory` is the ONE path the renderer supplies, and
 * it is a workspace the user already has open — it is used as routing evidence
 * only, never to derive a profile home.
 */
export const CopilotAccountPreviewRoutePayloadSchema = z
  .object({
    ...ipcAuthTokenField,
    workingDirectory: z.string().min(1).max(4096).optional(),
    explicitProfileId: CopilotProfileIdSchema.optional(),
    confirmProtectedOverride: z.boolean().optional(),
    origin: z
      .enum([
        'interactive',
        'automation',
        'review',
        'verification',
        'loop',
        'workflow',
        'consensus',
        'failover',
        'internal',
      ])
      .optional(),
  })
  .strict();

export const CopilotAccountSuggestRulesPayloadSchema = z
  .object({ ...ipcAuthTokenField, workingDirectory: z.string().min(1).max(4096) })
  .strict();

export const CopilotAccountEmptyPayloadSchema = z
  .object({ ...ipcAuthTokenField })
  .strict()
  .or(z.undefined());
