import { describe, it, expect } from 'vitest';
import { OrphanedMessageCleaner, type CleanableMessage } from './orphaned-message-cleaner';

describe('OrphanedMessageCleaner', () => {
  it('tombstones incomplete assistant messages', () => {
    const messages: CleanableMessage[] = [
      { id: '1', role: 'user', content: 'Hello', complete: true },
      { id: '2', role: 'assistant', content: 'I will help you with...', complete: false },
    ];

    const cleaner = new OrphanedMessageCleaner();
    const result = cleaner.cleanOnFailover(messages, { failedProvider: 'claude-cli' });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].tombstoned).toBe(true);
    expect(result.messages[1].content).toContain('[Response interrupted');
    expect(result.tombstonedCount).toBe(1);
  });

  it('preserves complete messages', () => {
    const messages: CleanableMessage[] = [
      { id: '1', role: 'user', content: 'Hello', complete: true },
      { id: '2', role: 'assistant', content: 'Hi there!', complete: true },
      { id: '3', role: 'user', content: 'Help me', complete: true },
    ];

    const cleaner = new OrphanedMessageCleaner();
    const result = cleaner.cleanOnFailover(messages, { failedProvider: 'claude-cli' });
    expect(result.tombstonedCount).toBe(0);
  });

  it('removes orphaned tool_result messages without matching tool_use', () => {
    const messages: CleanableMessage[] = [
      { id: '1', role: 'user', content: 'Run ls', complete: true },
      { id: '2', role: 'assistant', content: '', complete: false, toolUseId: 'tu-1' },
      { id: '3', role: 'tool', content: 'file1\nfile2', complete: true, toolUseId: 'tu-1' },
    ];

    const cleaner = new OrphanedMessageCleaner();
    const result = cleaner.cleanOnFailover(messages, { failedProvider: 'claude-cli' });

    // Both assistant (incomplete) and orphaned tool result should be tombstoned
    expect(result.tombstonedCount).toBe(2);
  });

  it('strips signature blocks from cached-thinking models', () => {
    const messages: CleanableMessage[] = [
      { id: '1', role: 'assistant', content: 'Response\n<signature>abc123</signature>', complete: true },
    ];

    const cleaner = new OrphanedMessageCleaner();
    const result = cleaner.cleanForFallbackModel(messages);
    expect(result.messages[0].content).not.toContain('<signature>');
  });
});
