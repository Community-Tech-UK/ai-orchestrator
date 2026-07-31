import { z } from 'zod';
import { LOCAL_AI_TARGET_NUMERIC_LIMITS } from '../types/local-ai-guard.types';

export const LocalAiRoutingRoleSchema = z.enum([
  'compression',
  'memoryDistillation',
  'webExtract',
  'titleGeneration',
  'routingClassification',
  'approvalScoring',
  'approvalAdjudication',
  'loopScoring',
  'retrievalHypothesis',
  'branchScoring',
  'subQueryExecution',
  'verifyOutputSummary',
]);

export const LocalAiExpectedModelSchema = z.object({
  modelId: z.string().trim().min(1).max(256),
  required: z.boolean(),
  minContextLength: z.number().finite().int()
    .min(LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength.min)
    .max(LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength.max)
    .optional(),
  routingRoles: z.array(LocalAiRoutingRoleSchema).max(50).optional(),
}).strict();

export function requireValidTargetModelRelationships(
  target: {
    expectedModels?: { modelId: string; routingRoles?: string[] }[];
    canary?: { model: string };
    routingRoles?: string[];
  },
  context: z.core.$RefinementCtx,
): void {
  const modelIds = target.expectedModels?.map(({ modelId }) => modelId);
  if (modelIds && new Set(modelIds).size !== modelIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['expectedModels'],
      message: 'Expected Local AI model IDs must be unique',
    });
  }
  if (modelIds && target.canary && !modelIds.includes(target.canary.model)) {
    context.addIssue({
      code: 'custom',
      path: ['canary', 'model'],
      message: 'Canary model must be present in expectedModels',
    });
  }
  if (!target.routingRoles) return;

  const targetRoles = new Set(target.routingRoles);
  target.expectedModels?.forEach((model, modelIndex) => {
    if (model.routingRoles && new Set(model.routingRoles).size !== model.routingRoles.length) {
      context.addIssue({
        code: 'custom',
        path: ['expectedModels', modelIndex, 'routingRoles'],
        message: 'Expected-model routing roles must be unique',
      });
    }
    model.routingRoles?.forEach((role) => {
      if (!targetRoles.has(role)) {
        context.addIssue({
          code: 'custom',
          path: ['expectedModels', modelIndex, 'routingRoles'],
          message: 'Expected-model routing roles must belong to the target',
        });
      }
    });
  });
}
