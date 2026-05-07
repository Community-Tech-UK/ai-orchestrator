import { describe, expect, it } from 'vitest';
import {
  ChatCreatePayloadSchema,
  ChatProviderSchema,
  ChatRenamePayloadSchema,
  ChatSendMessagePayloadSchema,
  ChatSetCwdPayloadSchema,
  ChatSetModelPayloadSchema,
  ChatSetProviderPayloadSchema,
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
    expect(ChatSetYoloPayloadSchema.safeParse({ chatId: 'chat-1', yolo: false }).success).toBe(true);
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
