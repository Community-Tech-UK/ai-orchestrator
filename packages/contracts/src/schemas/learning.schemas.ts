import { z } from 'zod';
import {
  InstanceIdSchema,
  SessionIdSchema,
  StoreIdSchema,
} from './common.schemas';

export const RlmAddSectionPayloadSchema = z.object({
  storeId: StoreIdSchema,
  type: z.enum(['file', 'conversation', 'tool_output', 'external', 'summary']),
  name: z.string().min(1).max(200),
  content: z.string().max(10_000_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const RlmCreateStorePayloadSchema = InstanceIdSchema;
export const RlmStoreIdPayloadSchema = StoreIdSchema;
export const RlmSessionIdPayloadSchema = SessionIdSchema;
export const RlmEmptyPayloadSchema = z.undefined().optional();

export const RlmRemoveSectionPayloadSchema = z.object({
  storeId: StoreIdSchema,
  sectionId: z.string().min(1).max(200),
});

export const RlmStartSessionPayloadSchema = z.object({
  storeId: StoreIdSchema,
  instanceId: InstanceIdSchema,
}).strict();

export const RlmContextQuerySchema = z.object({
  type: z.enum([
    'grep',
    'slice',
    'summarize',
    'sub_query',
    'get_section',
    'semantic_search',
  ]),
  params: z.record(z.string(), z.unknown()),
}).strict();

export const RlmExecuteQueryPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  query: RlmContextQuerySchema,
  depth: z.number().int().min(0).max(20).optional(),
}).strict();

export const RlmContextSectionEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['file', 'conversation', 'tool_output', 'external', 'summary']),
  name: z.string().min(1).max(200),
  content: z.string().max(10_000_000),
  tokens: z.number().int().nonnegative(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  checksum: z.string().min(1).max(1_000),
  filePath: z.string().max(10_000).optional(),
  language: z.string().max(200).optional(),
  sourceUrl: z.string().max(10_000).optional(),
  summarizes: z.array(z.string().min(1).max(200)).optional(),
  depth: z.number().int().nonnegative(),
  parentSummaryId: z.string().min(1).max(200).optional(),
});

export const RlmContextStoreEventSchema = z.object({
  id: StoreIdSchema,
  instanceId: InstanceIdSchema,
  sections: z.array(RlmContextSectionEventSchema).max(1_000),
  totalTokens: z.number().int().nonnegative(),
  totalSize: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  lastAccessed: z.number().int().nonnegative(),
  accessCount: z.number().int().nonnegative(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const RlmContextQueryResultEventSchema: z.ZodType = z.lazy(() => z.object({
  query: RlmContextQuerySchema,
  result: z.string(),
  tokensUsed: z.number().int().nonnegative(),
  sectionsAccessed: z.array(z.string().min(1).max(200)),
  duration: z.number().nonnegative().finite(),
  subQueries: z.array(RlmContextQueryResultEventSchema).optional(),
  depth: z.number().int().nonnegative(),
}));

export const RlmStoreUpdatedEventSchema = z.object({
  storeId: StoreIdSchema,
  store: RlmContextStoreEventSchema,
}).strict();

export const RlmSectionAddedEventSchema = z.object({
  storeId: StoreIdSchema,
  section: RlmContextSectionEventSchema,
}).strict();

export const RlmSectionRemovedEventSchema = z.object({
  storeId: StoreIdSchema,
  sectionId: z.string().min(1).max(200),
}).strict();

export const RlmQueryCompleteEventSchema = z.object({
  sessionId: SessionIdSchema,
  queryResult: RlmContextQueryResultEventSchema,
}).strict();

export const RlmConfigurePayloadSchema = z.object({
  maxSectionTokens: z.number().int().min(1).max(10_000_000).optional(),
  summaryThreshold: z.number().int().min(1).max(100_000_000).optional(),
  searchWindowSize: z.number().int().min(1).max(10_000_000).optional(),
  maxRecursionDepth: z.number().int().min(0).max(20).optional(),
  maxSubQueries: z.number().int().min(1).max(1_000).optional(),
  subQueryTimeout: z.number().int().min(100).max(3_600_000).optional(),
  summarizeModel: z.string().min(1).max(512).optional(),
  summaryTargetRatio: z.number().positive().max(1).optional(),
  enableCostTracking: z.boolean().optional(),
  costPerInputToken: z.number().nonnegative().finite().optional(),
  costPerOutputToken: z.number().nonnegative().finite().optional(),
}).strict();

export const RlmGetPatternsPayloadSchema = z.object({
  minSuccessRate: z.number().min(0).max(1).optional(),
}).optional();

export const RlmGetStrategySuggestionsPayloadSchema = z.object({
  context: z.string().min(1).max(1_000_000),
  maxSuggestions: z.number().int().min(1).max(100).optional(),
});

export const RlmTokenSavingsPayloadSchema = z.object({
  range: z.enum(['7d', '30d', '90d']).optional().default('30d'),
}).strict().optional().default({ range: '30d' });

export const RlmQueryStatsPayloadSchema = z.object({
  range: z.enum(['7d', '30d', '90d']).optional().default('30d'),
}).strict().optional().default({ range: '30d' });

const LearningToolUsageRecordSchema = z.object({
  tool: z.string().min(1).max(200),
  count: z.number().int().nonnegative(),
  avgDuration: z.number().nonnegative().finite(),
  errorCount: z.number().int().nonnegative(),
}).strict();

export const LearningRecordOutcomePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  taskType: z.string().min(1).max(200),
  taskDescription: z.string().max(100_000),
  prompt: z.string().max(500_000),
  context: z.string().max(1_000_000).optional(),
  agentUsed: z.string().min(1).max(200),
  modelUsed: z.string().min(1).max(500),
  workflowUsed: z.string().max(200).optional(),
  toolsUsed: z.array(LearningToolUsageRecordSchema).max(10_000),
  tokensUsed: z.number().int().nonnegative(),
  duration: z.number().nonnegative().finite(),
  success: z.boolean(),
  completionScore: z.number().min(0).max(1).optional(),
  userSatisfaction: z.number().min(1).max(5).optional(),
  errorType: z.string().max(200).optional(),
  errorMessage: z.string().max(100_000).optional(),
}).strict();

export const LearningOutcomeIdPayloadSchema = z.string().min(1).max(200);
export const LearningRecentOutcomesPayloadSchema = z.number().int().min(1).max(10_000).optional();
export const LearningTaskTypePayloadSchema = z.string().min(1).max(200);
export const LearningEmptyPayloadSchema = z.undefined().optional();

export const LearningConfigurePayloadSchema = z.object({
  minSampleSize: z.number().int().min(1).max(1_000_000).optional(),
  patternDecayRate: z.number().min(0).max(1).optional(),
  insightThreshold: z.number().min(0).max(1).optional(),
  maxExperiences: z.number().int().min(1).max(1_000_000).optional(),
  experienceRetention: z.number().int().min(1).max(36_500).optional(),
  enableAutoEnhancement: z.boolean().optional(),
  maxEnhancementTokens: z.number().int().min(1).max(1_000_000).optional(),
  enableABTesting: z.boolean().optional(),
  minABTestSamples: z.number().int().min(1).max(1_000_000).optional(),
}).strict();

export const LearningGetInsightsPayloadSchema = z.object({
  taskType: z.string().max(200).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
}).optional();

export const LearningGetRecommendationPayloadSchema = z.object({
  taskType: z.string().min(1).max(200),
  taskDescription: z.string().max(10_000).optional(),
  context: z.string().max(1_000_000).optional(),
});

export const LearningEnhancePromptPayloadSchema = z.object({
  prompt: z.string().min(1).max(500_000),
  taskType: z.string().max(200).optional(),
  context: z.string().max(1_000_000).optional(),
});

export const LearningRateOutcomePayloadSchema = z.object({
  outcomeId: z.string().min(1).max(200),
  satisfaction: z.number().min(0).max(1),
});

const AbExperimentIdSchema = z.string().min(1).max(200);

const AbVariantInputSchema = z.object({
  name: z.string().min(1).max(200),
  template: z.string().min(1).max(500_000),
  weight: z.number().nonnegative().finite(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const AbCreateExperimentPayloadSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1_000).optional(),
  taskType: z.string().min(1).max(200),
  variants: z.array(AbVariantInputSchema).min(2).max(100),
  minSamples: z.number().int().min(1).max(1_000_000).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
}).strict();

export const AbExperimentIdPayloadSchema = z.object({
  experimentId: AbExperimentIdSchema,
}).strict();

export const AbDeleteExperimentPayloadSchema = AbExperimentIdSchema;
export const AbEmptyPayloadSchema = z.undefined().optional();

export const AbUpdateExperimentPayloadSchema = z.object({
  experimentId: AbExperimentIdSchema,
  updates: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    minSamples: z.number().int().min(1).max(1_000_000).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
  }).strict(),
}).strict();

export const AbGetVariantPayloadSchema = z.object({
  taskType: z.string().min(1).max(200),
  sessionId: SessionIdSchema.optional(),
}).strict();

export const AbRecordOutcomePayloadSchema = z.object({
  experimentId: AbExperimentIdSchema,
  variantId: z.string().min(1).max(200),
  outcome: z.object({
    success: z.boolean(),
    duration: z.number().int().min(0).optional(),
    tokens: z.number().int().min(0).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict();

export const AbListExperimentsPayloadSchema = z.object({
  status: z.enum(['running', 'paused', 'completed', 'draft']).optional(),
  taskType: z.string().max(200).optional(),
}).strict().optional();

export const AbConfigurePayloadSchema = z.object({
  autoAssign: z.boolean().optional(),
  minSamplesPerVariant: z.number().int().min(1).max(1_000_000).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  maxConcurrentExperiments: z.number().int().min(1).max(10_000).optional(),
  persistResults: z.boolean().optional(),
}).strict();
