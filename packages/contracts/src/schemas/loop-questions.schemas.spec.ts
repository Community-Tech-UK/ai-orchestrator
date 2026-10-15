import { describe, expect, it } from 'vitest';
import { LoopAnswerOutstandingPayloadSchema } from './loop-questions.schemas';
import { LoopOutstandingChangedEventSchema } from './loop-events.schemas';
it('accepts the three real outstanding push forms and rejects unexpected keys', () => {
  expect(LoopOutstandingChangedEventSchema.safeParse({ itemId: 'item' }).success).toBe(true);
  expect(LoopOutstandingChangedEventSchema.safeParse({ chatId: 'chat', workspaceCwd: '/repo' }).success).toBe(true);
  expect(LoopOutstandingChangedEventSchema.safeParse({ loopRunId: 'run', chatId: 'chat', workspaceCwd: '/repo', newItemIds: ['item'] }).success).toBe(true);
  expect(LoopOutstandingChangedEventSchema.safeParse({ evil: true }).success).toBe(false);
});
it('bounds answers and accepts every operator action', () => {
  for (const action of ['answer', 'use-suggestion', 'keep', 'undo', 'dismiss']) expect(LoopAnswerOutstandingPayloadSchema.safeParse({ id: 'item', action, response: 'Yes', expectedRecommendation: null }).success).toBe(true);
  expect(LoopAnswerOutstandingPayloadSchema.safeParse({ id: 'item', action: 'answer', response: 'x'.repeat(4001) }).success).toBe(false);
});
