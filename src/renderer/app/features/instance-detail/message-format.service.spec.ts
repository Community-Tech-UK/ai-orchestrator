import { describe, expect, it } from 'vitest';
import { MessageFormatService } from './message-format.service';
import type { DisplayItem } from './display-item-processor.service';

describe('MessageFormatService', () => {
  const service = new MessageFormatService();

  it('says a summary restart continued from a summary, never a fresh session, and keeps in-place compaction distinct', () => {
    const message = { id: 'compact', type: 'system' as const, timestamp: 1, content: '', metadata: { method: 'restart-with-summary', previousUsage: { percentage: 82 }, newUsage: { percentage: 31 } } };
    expect(service.getCompactionLabel(message)).toBe('Continued from a summary · was 82%, new size shows after the next reply');
    expect(service.getCompactionLabel({ ...message, metadata: { method: 'restart-with-summary' } })).toBe('Continued from a summary · new size shows after the next reply');
    expect(service.getCompactionLabel(message)).not.toMatch(/fresh session/i);
    expect(service.getCompactionLabel({ ...message, metadata: { ...message.metadata, method: 'native' } })).toBe('Context compacted in place (82% → 31%)');
  });

  describe('summarizeCycle', () => {
    it('counts thinking blocks, not thought-groups', () => {
      const cycle: DisplayItem = {
        id: 'cycle-1',
        type: 'work-cycle',
        children: [
          {
            id: 'thought-t1',
            type: 'thought-group',
            thinking: [
              { id: 'a', content: 'one', format: 'structured' },
              { id: 'b', content: 'two', format: 'structured' },
              { id: 'c', content: 'three', format: 'structured' },
            ],
            thoughts: ['one', 'two', 'three'],
          },
        ],
      };
      expect(service.summarizeCycle(cycle)).toBe('Thought 3 times');
    });

    it('names what the tools did in words and always counts a failure', () => {
      const tool = (id: string, name: string, input: Record<string, unknown>) =>
        ({ id: `use-${id}`, type: 'tool_use' as const, timestamp: 1, content: '', metadata: { id, name, input } });
      const result = (id: string, isError: boolean) =>
        ({ id: `res-${id}`, type: 'tool_result' as const, timestamp: 2, content: isError ? 'exit 1' : 'ok', metadata: { tool_use_id: id, is_error: isError } });
      const cycle: DisplayItem = {
        id: 'cycle-2',
        type: 'work-cycle',
        children: [
          { id: 'thought-t1', type: 'thought-group', thinking: [{ id: 'a', content: 'one', format: 'structured' }], thoughts: ['one'] },
          {
            id: 'tools-1',
            type: 'tool-group',
            toolMessages: [
              tool('1', 'Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }), result('1', false),
              tool('2', 'Edit', { file_path: '/p/b.ts', old_string: 'a', new_string: 'b' }), result('2', false),
              tool('3', 'Bash', { command: 'npm test' }), result('3', true),
              tool('4', 'Bash', { command: 'ls' }), result('4', false),
            ],
          },
        ],
      };
      const text = service.summarizeCycle(cycle);
      expect(text).toMatch(/^Thought 1 time · edited 2 files/);
      expect(text).toContain('ran 2 commands');
      expect(text).toMatch(/ · 1 failed$/);
      expect(text).not.toMatch(/\bBash\b|\bEdit\b/);
    });

    it('uses singular for a single thinking block', () => {
      const cycle: DisplayItem = {
        id: 'cycle-1',
        type: 'work-cycle',
        children: [
          {
            id: 'thought-t1',
            type: 'thought-group',
            thinking: [{ id: 'a', content: 'one', format: 'structured' }],
            thoughts: ['one'],
          },
        ],
      };
      expect(service.summarizeCycle(cycle)).toBe('Thought 1 time');
    });
  });

  it('formats compaction reasons for transcript cards', () => {
    expect(service.formatCompactionReason('hard_limit')).toBe('history threshold');
    expect(service.formatCompactionReason('background_threshold')).toBe('context budget');
    expect(service.formatCompactionReason('context-budget')).toBe('context budget');
    expect(service.formatCompactionReason('manual_reason')).toBe('manual reason');
  });

  it('formats compaction fallback modes for transcript cards', () => {
    expect(service.formatCompactionFallbackMode('in-place')).toBe('in place');
    expect(service.formatCompactionFallbackMode('native-resume')).toBe('native resume');
  });

  it('renders a legacy Compact-turn rejection as a compaction notice instead of an error card', () => {
    const message = {
      id: 'legacy-compact-error',
      type: 'error' as const,
      timestamp: 1,
      content: 'Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
    };

    expect(service.isCompactionBoundary(message)).toBe(true);
    expect(service.getCompactionLabel(message)).toBe('Codex is compacting its context…');
  });

  it('labels a self-managed boundary truthfully while fresh usage is pending', () => {
    const message = {
      id: 'self-managed',
      type: 'system' as const,
      timestamp: 1,
      content: 'Codex compacted the conversation.',
      metadata: { threadCompacted: true, method: 'self-managed' },
    };

    expect(service.getCompactionLabel(message)).toBe(
      'Codex compacted its own context (awaiting updated usage)',
    );
  });

  it('says how full the context was when the boundary carries the last measured reading', () => {
    const message = {
      id: 'self-managed-with-prior',
      type: 'system' as const,
      timestamp: 1,
      content: 'Codex compacted the conversation.',
      metadata: { threadCompacted: true, method: 'self-managed', previousUsage: { percentage: 88.4 } },
    };

    expect(service.getCompactionLabel(message)).toBe('Codex compacted its own context (was 88%)');
  });

  describe('compaction wording follows the session\'s provider', () => {
    const rejection = {
      id: 'legacy-compact-error',
      type: 'error' as const,
      timestamp: 1,
      content: 'Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
    };
    const selfManaged = {
      id: 'self-managed',
      type: 'system' as const,
      timestamp: 1,
      content: 'Compacted the conversation.',
      metadata: { threadCompacted: true, method: 'self-managed', previousUsage: { percentage: 88.4 } },
    };

    it('names the provider it is given instead of always saying Codex', () => {
      expect(service.getCompactionLabel(rejection, 'claude')).toBe('Claude is compacting its context…');
      expect(service.getCompactionLabel(selfManaged, 'copilot')).toBe('Copilot compacted its own context (was 88%)');
      expect(service.getCompactionLabel({
        ...selfManaged,
        metadata: { ...selfManaged.metadata, newUsage: { percentage: 31 } },
      }, 'cursor')).toBe('Cursor compacted its own context (88% → 31%)');
      expect(service.getCompactionLabel({ ...selfManaged, metadata: { threadCompacted: true, method: 'self-managed' } }, 'opencode'))
        .toBe('OpenCode compacted its own context (awaiting updated usage)');
    });

    it('uses the provider recorded on the message when the caller passes none', () => {
      expect(service.getCompactionLabel({
        ...selfManaged,
        metadata: { ...selfManaged.metadata, provider: 'gemini' },
      })).toBe('Gemini compacted its own context (was 88%)');
    });

    it('keeps saying Codex when nothing names a provider, because only Codex emits these shapes', () => {
      expect(service.getCompactionLabel(rejection)).toBe('Codex is compacting its context…');
      expect(service.getCompactionLabel(selfManaged)).toBe('Codex compacted its own context (was 88%)');
    });

    it('leaves provider-neutral boundaries alone', () => {
      const native = { id: 'n', type: 'system' as const, timestamp: 1, content: '', metadata: { method: 'native', previousUsage: { percentage: 82 }, newUsage: { percentage: 31 } } };
      expect(service.getCompactionLabel(native, 'claude')).toBe('Context compacted in place (82% → 31%)');
    });
  });

  it('names providers through the shared name list, not a local one', () => {
    expect(service.getProviderDisplayName('codex')).toBe('Codex');
    expect(service.getProviderDisplayName('opencode')).toBe('OpenCode');
    expect(service.getProviderDisplayName('claude')).toBe('Claude');
    expect(service.getProviderDisplayName('some-new-tool')).toBe('Some new tool');
  });

  // LT-657: Harness-authored input must never be labelled as the user.
  describe('message sender labels', () => {
    const harnessMessage = {
      type: 'system' as const,
      metadata: { internalInput: { actor: 'harness' as const, source: 'context-policy' as const } },
    };

    it('labels Harness-authored input as Harness and explains it is not from the user', () => {
      expect(service.formatMessageLabel(harnessMessage, 'codex')).toBe('Harness (automated)');
      expect(service.describeMessageSender(harnessMessage)).toBe(
        'Sent to the agent automatically by Harness (context-policy). This is not a message from you.',
      );
    });

    it('explains an automatic carry-on in plain words, without the internal source name', () => {
      const sentence = service.describeMessageSender({ metadata: { internalInput: { actor: 'harness', source: 'session-watcher' } } });
      expect(sentence).toBe('Harness told the agent to carry on, because "Keep sessions going without me" is on. This is not a message from you.');
      expect(sentence).not.toContain('session-watcher');
    });

    it('says the same of the rule-based answer to "shall I carry on?", which the same setting switches on', () => {
      const ruleReply = { metadata: { internalInput: { actor: 'harness' as const, source: 'continue-question-reply' as const } } };
      expect(service.isKeepGoingReply(ruleReply)).toBe(true);
      expect(service.describeMessageSender(ruleReply)).toBe(
        'Harness told the agent to carry on, because "Keep sessions going without me" is on. This is not a message from you.',
      );
      expect(service.isKeepGoingReply(harnessMessage)).toBe(false);
    });

    it('keeps the ordinary labels for user, assistant and system messages', () => {
      expect(service.formatMessageLabel({ type: 'user' }, 'codex')).toBe('You');
      expect(service.formatMessageLabel({ type: 'assistant' }, 'codex')).toBe('Codex');
      expect(service.formatMessageLabel({ type: 'system' }, 'codex')).toBe('System');
      expect(service.describeMessageSender({})).toBe('');
    });
  });
});
