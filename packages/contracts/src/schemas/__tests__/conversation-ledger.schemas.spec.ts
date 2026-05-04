import { describe, expect, it } from 'vitest';
import {
  ConversationLedgerDiscoverPayloadSchema,
  ConversationLedgerListPayloadSchema,
  ConversationLedgerSendTurnPayloadSchema,
  ConversationLedgerStartPayloadSchema,
  ConversationLedgerThreadIdPayloadSchema,
} from '../conversation-ledger.schemas';

describe('conversation ledger IPC schemas', () => {
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
    expect(ConversationLedgerSendTurnPayloadSchema.parse({
      threadId: 'thread_1',
      text: 'Continue',
      inputItems: [{ type: 'text', text: 'Continue' }],
    }).inputItems).toHaveLength(1);
  });
});
