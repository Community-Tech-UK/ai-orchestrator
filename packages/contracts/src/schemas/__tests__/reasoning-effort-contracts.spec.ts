import { describe, expect, it } from 'vitest';
import { AutomationReasoningEffortSchema } from '../automation.schemas';
import { ChatReasoningEffortSchema, ChatSetReasoningPayloadSchema } from '../chat.schemas';
import { InstanceCreatePayloadSchema } from '../instance.schemas';

const instanceEffortSchema = InstanceCreatePayloadSchema.shape.reasoningEffort;

describe('reasoning effort boundary contracts', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])('preserves Codex %s across each boundary', effort => {
    expect(ChatReasoningEffortSchema.parse(effort)).toBe(effort);
    expect(instanceEffortSchema.parse(effort)).toBe(effort);
    expect(AutomationReasoningEffortSchema.parse(effort)).toBe(effort);
    expect(ChatSetReasoningPayloadSchema.parse({ chatId: 'chat-1', reasoningEffort: effort }).reasoningEffort).toBe(effort);
  });
  it('continues to reject unrecognised levels', () => {
    for (const schema of [ChatReasoningEffortSchema, instanceEffortSchema, AutomationReasoningEffortSchema]) {
      expect(schema.safeParse('future-effort').success).toBe(false);
    }
  });
});
