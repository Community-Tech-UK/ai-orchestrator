import { describe, expect, it } from 'vitest';
import {
  ConversationLedgerDiscoverPayloadSchema,
  ConversationLedgerListPayloadSchema,
  ConversationLedgerSendTurnPayloadSchema,
  ConversationLedgerStartPayloadSchema,
  ConversationLedgerThreadIdPayloadSchema,
} from '../conversation-ledger.schemas';

describe('conversation ledger IPC schemas', () => {
  const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
  const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

  it('validates narrow list and thread payloads', () => {
    expect(ConversationLedgerListPayloadSchema.parse({ provider: 'codex', limit: 25 })).toMatchObject({
      provider: 'codex',
      limit: 25,
    });
    expect(ConversationLedgerThreadIdPayloadSchema.parse({ threadId: 'thread_1' })).toEqual({
      threadId: 'thread_1',
    });
  });

  it('validates discovery, start, and send-turn payloads', () => {
    expect(ConversationLedgerDiscoverPayloadSchema.parse({
      workspacePath: '/tmp/project',
      sourceKinds: ['cli', 'appServer'],
    }).sourceKinds).toContain('appServer');
    expect(ConversationLedgerStartPayloadSchema.parse({
      provider: 'codex',
      workspacePath: '/tmp/project',
      ephemeral: false,
    }).ephemeral).toBe(false);
    expect(ConversationLedgerStartPayloadSchema.parse({
      provider: 'orchestrator',
      workspacePath: null,
      title: 'Orchestrator',
      parentConversationId: 'thread-parent',
      metadata: { scope: 'global' },
    })).toMatchObject({
      provider: 'orchestrator',
      workspacePath: null,
      title: 'Orchestrator',
      parentConversationId: 'thread-parent',
      metadata: { scope: 'global' },
    });
    expect(ConversationLedgerSendTurnPayloadSchema.parse({
      threadId: 'thread_1',
      text: 'Continue',
      inputItems: [{ type: 'text', text: 'Continue' }],
    }).inputItems).toHaveLength(1);
  });

  it('accepts conversation model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    expect(ConversationLedgerStartPayloadSchema.safeParse({
      provider: 'codex',
      workspacePath: '/tmp/project',
      model: maxCatalogModelId,
    }).success).toBe(true);
    expect(ConversationLedgerSendTurnPayloadSchema.safeParse({
      threadId: 'thread_1',
      text: 'Continue',
      model: maxCatalogModelId,
    }).success).toBe(true);
  });

  it('rejects conversation model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(ConversationLedgerStartPayloadSchema.safeParse({
      provider: 'codex',
      workspacePath: '/tmp/project',
      model: tooLongCatalogModelId,
    }).success).toBe(false);
    expect(ConversationLedgerSendTurnPayloadSchema.safeParse({
      threadId: 'thread_1',
      text: 'Continue',
      model: tooLongCatalogModelId,
    }).success).toBe(false);
  });
});
