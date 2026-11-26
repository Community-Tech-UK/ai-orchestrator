import { z } from 'zod';
import type { AuxiliaryLlmProvider, AuxiliaryLlmSlot } from '../../../shared/types/auxiliary-llm.types';
import type { OrchestrationRoutingPolicyKey } from '../../../shared/types/settings.types';
import type { ClosedSettingsToolPolicy, OpenSettingsToolPolicy } from './settings-control-policy';

interface PolicyBuilders {
  open: (schema: z.ZodType<unknown>, restartRequired?: boolean) => OpenSettingsToolPolicy;
  readOnly: (restartRequired?: boolean, schema?: z.ZodType<unknown>) => ClosedSettingsToolPolicy;
  secret: (restartRequired?: boolean) => ClosedSettingsToolPolicy;
  modelIdSchema: z.ZodString;
  shortStringSchema: z.ZodString;
  jsonBackedObjectSchema: (schema: z.ZodType<unknown>) => z.ZodType<unknown>;
}

/** Pure policy group; the facade supplies the same shared schema/builders. */
export function createAuxiliarySettingsPolicy(builders: PolicyBuilders) {
  const { open, readOnly, secret, modelIdSchema, shortStringSchema, jsonBackedObjectSchema } = builders;
  const auxiliaryRoutingModeSchema = z.enum(['off', 'local-first', 'cheap-first', 'manual-only']);
  const localAiFallbackPolicySchema = z.enum([
    'allow-silently',
    'notify-and-allow',
    'require-confirmation',
    'defer-locally',
    'block-paid-fallback',
  ]);
  const auxiliaryProviderSchema = z.enum([
    'ollama',
    'openai-compatible',
    'anthropic',
    'openai',
    'local-fallback',
    'auto',
  ] satisfies (AuxiliaryLlmProvider | 'auto')[]);
  const auxiliarySlotSchema = z.object({
    enabled: z.boolean(),
    provider: auxiliaryProviderSchema.optional(),
    endpointId: shortStringSchema.optional(),
    model: modelIdSchema.refine((value) => value.length > 0, {
      message: 'String must contain at least 1 character(s)',
    }).optional(),
    tier: z.enum(['quick', 'quality']).optional(),
    maxInputTokens: z.number().finite().int().min(1).max(1_000_000),
    maxOutputTokens: z.number().finite().int().min(1).max(1_000_000),
    temperature: z.number().finite().min(0).max(2),
    timeoutMs: z.number().finite().int().min(1).max(600_000),
    requireJson: z.boolean(),
    allowFrontierFallback: z.boolean(),
  }).strict();
  const auxiliarySlotMapSchema = z.object({
    compression: auxiliarySlotSchema.optional(),
    memoryDistillation: auxiliarySlotSchema.optional(),
    webExtract: auxiliarySlotSchema.optional(),
    titleGeneration: auxiliarySlotSchema.optional(),
    routingClassification: auxiliarySlotSchema.optional(),
    approvalScoring: auxiliarySlotSchema.optional(),
    approvalAdjudication: auxiliarySlotSchema.optional(),
    loopScoring: auxiliarySlotSchema.optional(),
    retrievalHypothesis: auxiliarySlotSchema.optional(),
    branchScoring: auxiliarySlotSchema.optional(),
    subQueryExecution: auxiliarySlotSchema.optional(),
    verifyOutputSummary: auxiliarySlotSchema.optional(),
  } satisfies Record<AuxiliaryLlmSlot, z.ZodOptional<typeof auxiliarySlotSchema>>).strict();
  const auxiliarySlotPayloadSchema = jsonBackedObjectSchema(auxiliarySlotMapSchema);

  // Operator routing policy: which model tier each orchestration gate uses.
  // `.strict()` so an unknown gate name is rejected loudly rather than silently
  // ignored — a typo'd key would otherwise leave that gate on its default and
  // look like the setting simply didn't work.
  const orchestrationRoutingPolicyValueSchema = z.enum(['auto', 'fast', 'balanced', 'powerful']);
  const orchestrationRoutingPolicyMapSchema = z.object({
    loop: orchestrationRoutingPolicyValueSchema.optional(),
    workflow: orchestrationRoutingPolicyValueSchema.optional(),
    verify: orchestrationRoutingPolicyValueSchema.optional(),
    review: orchestrationRoutingPolicyValueSchema.optional(),
    debate: orchestrationRoutingPolicyValueSchema.optional(),
    debateSynthesis: orchestrationRoutingPolicyValueSchema.optional(),
  } satisfies Record<
    OrchestrationRoutingPolicyKey,
    z.ZodOptional<typeof orchestrationRoutingPolicyValueSchema>
  >).strict();
  const orchestrationRoutingPolicySchema = jsonBackedObjectSchema(orchestrationRoutingPolicyMapSchema);

  return {
    auxiliaryLlmEnabled: open(z.boolean()),
    auxiliaryLlmRoutingMode: open(auxiliaryRoutingModeSchema),
    auxiliaryLlmAllowRemoteWorkerModels: open(z.boolean()),
    auxiliaryLlmUseLocalhostOllama: open(z.boolean()),
    auxiliaryLlmDailySpendCapUsd: open(z.number().finite().min(0).nullable()),
    auxiliaryLlmEndpointsJson: secret(),
    auxiliaryLlmSlotsJson: open(auxiliarySlotPayloadSchema),
    auxiliaryLlmQuickModel: open(modelIdSchema),
    auxiliaryLlmQualityModel: open(modelIdSchema),
    auxiliaryLlmRoutingClassificationEnabled: open(z.boolean()),
    localAiGuardDefaultFallbackPolicy: readOnly(false, localAiFallbackPolicySchema),
    localAiGuardDailyFallbackBudgetUsd: readOnly(
      false,
      z.number().finite().min(0).max(1_000_000).nullable(),
    ),
    localAiGuardConfirmAboveInputTokens: readOnly(
      false,
      z.number().finite().int().min(0).max(100_000_000).nullable(),
    ),
    // Strictly validated rather than a free-form string: a bad tier name here
    // would silently fall back to the default for that gate, hiding the typo.
    // Agent-writable, consistent with defaultModel / modelUsageByKey, which also
    // steer spend. It cannot escalate privilege — only pick a model tier.
    orchestrationRoutingPolicyJson: open(orchestrationRoutingPolicySchema),

  };
}
