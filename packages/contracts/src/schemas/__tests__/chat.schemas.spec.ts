import { describe, expect, it } from 'vitest';
import {
  ChatCreatePayloadSchema,
  ChatProviderSchema,
  ChatReasoningEffortSchema,
  ChatRenamePayloadSchema,
  ChatSendMessagePayloadSchema,
  ChatSetCwdPayloadSchema,
  ChatSetModelPayloadSchema,
  ChatSetProviderPayloadSchema,
  ChatSetReasoningPayloadSchema,
  ChatSetYoloPayloadSchema,
} from '../chat.schemas';

describe('chat schemas', () => {
  it('allows only provider-backed chat providers for v1', () => {
    expect(ChatProviderSchema.options).toEqual(['claude', 'codex', 'gemini', 'copilot']);
    expect(ChatProviderSchema.safeParse('auto').success).toBe(false);
    expect(ChatProviderSchema.safeParse('cursor').success).toBe(false);
  });

  it('requires create payloads to include provider and working directory', () => {
    expect(ChatCreatePayloadSchema.parse({
      provider: 'claude',
      currentCwd: '/work/project',
      model: null,
      yolo: true,
    })).toMatchObject({
      provider: 'claude',
      currentCwd: '/work/project',
      model: null,
      yolo: true,
    });

    expect(ChatCreatePayloadSchema.safeParse({
      provider: 'claude',
      currentCwd: '',
    }).success).toBe(false);
  });

  it('validates mutating chat payloads', () => {
    expect(ChatRenamePayloadSchema.safeParse({ chatId: 'chat-1', name: 'Renamed' }).success).toBe(true);
    expect(ChatSetCwdPayloadSchema.safeParse({ chatId: 'chat-1', cwd: '/next' }).success).toBe(true);
    expect(ChatSetProviderPayloadSchema.safeParse({ chatId: 'chat-1', provider: 'gemini' }).success).toBe(true);
    expect(ChatSetModelPayloadSchema.safeParse({ chatId: 'chat-1', model: null }).success).toBe(true);
    expect(ChatSetReasoningPayloadSchema.safeParse({ chatId: 'chat-1', reasoningEffort: 'high' }).success).toBe(true);
    expect(ChatSetReasoningPayloadSchema.safeParse({ chatId: 'chat-1', reasoningEffort: null }).success).toBe(true);
    expect(ChatSetReasoningPayloadSchema.safeParse({ chatId: 'chat-1', reasoningEffort: 'wat' }).success).toBe(false);
    expect(ChatSetYoloPayloadSchema.safeParse({ chatId: 'chat-1', yolo: false }).success).toBe(true);
  });

  it('exposes the reasoning-effort enum for UI consumers', () => {
    expect(ChatReasoningEffortSchema.options).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(ChatReasoningEffortSchema.safeParse('extra').success).toBe(false);
  });

  it('accepts optional reasoningEffort on create payloads', () => {
    expect(ChatCreatePayloadSchema.safeParse({
      provider: 'codex',
      currentCwd: '/work/project',
      reasoningEffort: 'high',
    }).success).toBe(true);
    expect(ChatCreatePayloadSchema.safeParse({
      provider: 'codex',
      currentCwd: '/work/project',
      reasoningEffort: null,
    }).success).toBe(true);
    expect(ChatCreatePayloadSchema.safeParse({
      provider: 'codex',
      currentCwd: '/work/project',
      reasoningEffort: 'wat',
    }).success).toBe(false);
  });

  it('accepts bounded message text and file attachments with data URLs', () => {
    expect(ChatSendMessagePayloadSchema.safeParse({
      chatId: 'chat-1',
      text: 'List files',
      attachments: [
        {
          name: 'note.txt',
          type: 'text/plain',
          size: 4,
          data: 'data:text/plain;base64,dGVzdA==',
        },
      ],
    }).success).toBe(true);

    expect(ChatSendMessagePayloadSchema.safeParse({
      chatId: 'chat-1',
      text: '',
    }).success).toBe(false);
  });
});
