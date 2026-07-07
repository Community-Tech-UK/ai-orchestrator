import { z } from 'zod';

/**
 * Schemas for browser.execute_fill_plan — structured, read-back-verified form
 * filling. Kept in a sibling file (re-exported from browser.schemas.ts) so the
 * main browser schema module stays under the file-size ceiling. Self-contained:
 * no imports from browser.schemas.ts, to avoid an import cycle.
 */

const idSchema = z.string().min(1).max(200);

const BrowserFillControlExpectationSchema = z
  .object({
    value: z.string().max(10_000).optional(),
    selectedLabel: z.string().max(2_000).optional(),
    checked: z.boolean().optional(),
  })
  .strict();

export const BrowserFillPlanStepSchema = z
  .object({
    field: z.string().min(1).max(200),
    kind: z.enum(['set', 'select', 'check', 'section_save']),
    target: z.string().min(1).max(2_000),
    value: z.string().max(10_000).optional(),
    checked: z.boolean().optional(),
    probeTarget: z.string().min(1).max(2_000).optional(),
    effectProbe: BrowserFillControlExpectationSchema.optional(),
    expected: BrowserFillControlExpectationSchema.optional(),
  })
  .strict();
export type BrowserFillPlanStep = z.infer<typeof BrowserFillPlanStepSchema>;

export const BrowserExecuteFillPlanRequestSchema = z
  .object({
    profileId: idSchema,
    targetId: idSchema,
    steps: z.array(BrowserFillPlanStepSchema).min(1).max(200),
    maxAttempts: z.number().int().min(1).max(5).optional(),
  })
  .strict();
export type BrowserExecuteFillPlanRequest = z.infer<typeof BrowserExecuteFillPlanRequestSchema>;

export const BrowserFillCredentialRequestSchema = z
  .object({
    profileId: idSchema,
    targetId: idSchema,
    // A vault item reference, never a secret. Bounded like an id.
    vaultItemRef: z.string().min(1).max(200),
    fields: z
      .array(
        z
          .object({
            selector: z.string().min(1).max(2_000),
            // 'email_code' resolves a one-time verification code from the
            // agent mailbox (sender-domain + recency disambiguation) instead
            // of the vault. Gated by an 'email_code' authorization purpose.
            kind: z.enum(['username', 'password', 'totp', 'email_code']),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    // Tuning for email_code fields only. Sender domains must relate to the
    // live page origin (validated main-side) — never an arbitrary inbox scan.
    emailCode: z
      .object({
        senderDomains: z.array(z.string().min(3).max(253)).max(5).optional(),
        sinceMs: z.number().int().positive().optional(),
        withinMs: z.number().int().min(10_000).max(3_600_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrowserFillCredentialRequest = z.infer<typeof BrowserFillCredentialRequestSchema>;

export const BrowserCreateAgentCredentialRequestSchema = z
  .object({
    profileId: idSchema,
    targetId: idSchema,
    username: z.string().min(1).max(320),
  })
  .strict();
export type BrowserCreateAgentCredentialRequest = z.infer<
  typeof BrowserCreateAgentCredentialRequestSchema
>;
