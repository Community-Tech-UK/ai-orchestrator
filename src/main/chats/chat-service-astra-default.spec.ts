import { describe, expect, it, vi } from 'vitest';
import { ChatService } from './chat-service';
import type { ChatCreateInput } from '../../shared/types/chat.types';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({
    defaultModelByProvider: { codex: 'gpt-6-astra' }, defaultModel: 'sonnet',
  }) }),
}));

describe('chat creation with remembered Astra', () => {
  it.each([
    { input: {}, expected: 'medium' },
    { input: { model: 'gpt-5.6-sol' }, expected: 'high' },
    { input: { reasoningEffort: 'high' }, expected: 'high' },
    { input: { reasoningEffort: null }, expected: null },
  ] satisfies { input: Partial<ChatCreateInput>; expected: string | null }[])(
    'persists $expected for $input', async ({ input, expected }) => {
      const insert = vi.fn((chat: unknown) => chat);
      // Exercise the production creation method with persistence/ledger ports stubbed.
      const service = Object.assign(Object.create(ChatService.prototype), {
        initialize: vi.fn(),
        ledger: { startConversation: vi.fn(async () => ({ id: 'test-thread' })) },
        store: { insert },
        detailFor: vi.fn(async (chat: unknown) => ({ chat })),
        emit: vi.fn(),
      }) as ChatService;
      await service.createChat({ provider: 'codex', currentCwd: '/tmp/astra-default-test', ...input });
      expect(insert).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: expected }));
    },
  );
});
