import { z } from 'zod';

export const LoopAnswerOutstandingPayloadSchema = z.object({
  id: z.string().min(1),
  action: z.enum(['answer', 'use-suggestion', 'keep', 'undo', 'dismiss']),
  response: z.string().max(4000).optional(),
  expectedRecommendation: z.string().max(131072).nullable(),
}).strict();
export type LoopAnswerOutstandingPayload = z.infer<typeof LoopAnswerOutstandingPayloadSchema>;
export const LoopOutstandingQuestionFieldsShape = {
  riskClass: z.enum(['scope', 'money', 'deletion', 'shared']).nullish(),
  firstSeenRound: z.number().int().nonnegative().nullish(),
  outcome: z.enum(['answered', 'kept', 'undone', 'dismissed', 'withdrawn', 'superseded', 'seen']).nullish(),
  answerSentAt: z.number().int().nonnegative().nullish(),
};
