import { describe, expect, it } from 'vitest';
import {
  ChatCreatePayloadSchema,
  ChatDeletePayloadSchema,
  ChatProviderSchema,
  ChatReasoningEffortSchema,
  ChatRenamePayloadSchema,
  ChatSendMessagePayloadSchema,
  ChatSetCwdPayloadSchema,
  ChatSetModelPayloadSchema,
  ChatSetProviderPayloadSchema,
  ChatSetReasoningPayloadSchema,
  ChatSetYoloPayloadSchema,
  ChatUiStatePayloadSchema,
} from '../chat.schemas';

describe('chat schemas', () => {
  it('requires explicit destructive confirmation to delete a chat', () => {
    expect(ChatDeletePayloadSchema.safeParse({ chatId: 'chat-1', confirmation: 'delete' }).success)
      .toBe(true);
    expect(ChatDeletePayloadSchema.safeParse({ chatId: 'chat-1' }).success).toBe(false);
    expect(ChatDeletePayloadSchema.safeParse({ chatId: 'chat-1', confirmation: true }).success)
      .toBe(false);
  });
  const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
  const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

  it('allows only provider-backed chat providers for v1', () => {
    expect(ChatProviderSchema.options).toEqual(['claude', 'codex', 'gemini', 'antigravity', 'copilot']);
    expect(ChatProviderSchema.safeParse('auto').success).toBe(false);
    expect(ChatProviderSchema.safeParse('cursor').success).toBe(false);
  });

  it('requires create payloads to include provider and working directory', () => {
    expect(ChatCreatePayloadSchema.parse({
      provider: 'claude',
      currentCwd: '/work/project',
      model: null,
      parentChatId: 'chat-parent',
      yolo: true,
    })).toMatchObject({
      provider: 'claude',
      currentCwd: '/work/project',
      model: null,
      parentChatId: 'chat-parent',
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

  it('accepts chat model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    expect(ChatCreatePayloadSchema.safeParse({
      provider: 'claude',
      currentCwd: '/work/project',
      model: maxCatalogModelId,
    }).success).toBe(true);
    expect(ChatSetModelPayloadSchema.safeParse({
      chatId: 'chat-1',
      model: maxCatalogModelId,
    }).success).toBe(true);
  });

  it('rejects chat model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(ChatCreatePayloadSchema.safeParse({
      provider: 'claude',
      currentCwd: '/work/project',
      model: tooLongCatalogModelId,
    }).success).toBe(false);
    expect(ChatSetModelPayloadSchema.safeParse({
      chatId: 'chat-1',
      model: tooLongCatalogModelId,
    }).success).toBe(false);
  });

  it('exposes the reasoning-effort enum for UI consumers', () => {
    expect(ChatReasoningEffortSchema.options).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'workflow',
    ]);
    expect(ChatReasoningEffortSchema.safeParse('max').success).toBe(true);
    expect(ChatReasoningEffortSchema.safeParse('workflow').success).toBe(true);
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

  it('validates bounded chat UI-state payloads for crash restore', () => {
    expect(ChatUiStatePayloadSchema.parse({
      selectedChatId: 'chat-2',
      openChatIds: ['chat-1', 'chat-2'],
    })).toEqual({
      selectedChatId: 'chat-2',
      openChatIds: ['chat-1', 'chat-2'],
    });

    expect(ChatUiStatePayloadSchema.safeParse({
      selectedChatId: null,
      openChatIds: [],
    }).success).toBe(true);

    expect(ChatUiStatePayloadSchema.safeParse({
      selectedChatId: 'chat-1',
      openChatIds: Array.from({ length: 21 }, (_, index) => `chat-${index}`),
    }).success).toBe(false);
  });
});
