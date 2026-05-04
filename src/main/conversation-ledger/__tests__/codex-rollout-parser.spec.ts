import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseCodexRolloutJsonl } from '../codex/codex-rollout-parser';

const fixturePath = join(__dirname, '../__fixtures__/codex-rollout-current.jsonl');

describe('Codex rollout parser', () => {
  it('parses the current nested payload shape and deduplicates final assistant text', () => {
    const snapshot = parseCodexRolloutJsonl(readFileSync(fixturePath, 'utf8'), {
      sourcePath: fixturePath,
    });

    expect(snapshot.thread).toMatchObject({
      provider: 'codex',
      nativeThreadId: 'thread_fixture_1',
      workspacePath: '/tmp/ai-orchestrator-fixture',
      nativeSourceKind: 'vscode',
      title: 'Ledger planning',
    });
    expect(snapshot.messages.map(message => `${message.role}:${message.content.split('\n')[0]}`)).toEqual([
      'user:Plan the conversation ledger.',
      'tool:shell {"cmd":"pwd"}',
      'tool:Command exited with 0',
      'assistant:Use an Orchestrator-owned ledger first.',
    ]);
    expect(snapshot.tokenTotals).toMatchObject({ input: 12, output: 8 });
    expect(new Set(snapshot.messages.map(message => message.sequence)).size).toBe(snapshot.messages.length);
  });

  it('tolerates malformed lines, legacy flat records, missing cwd, and response items', () => {
    const snapshot = parseCodexRolloutJsonl([
      'not json',
      JSON.stringify({ type: 'session_meta', id: 'legacy-thread', model: 'gpt-5.5' }),
      JSON.stringify({ type: 'event_msg', subtype: 'user_message', message: 'legacy user', threadId: 'legacy-thread' }),
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: ['thinking'] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'tool output' } }),
      JSON.stringify({ type: 'event_msg', subtype: 'token_count', input_tokens: 2, output_tokens: 3 }),
    ].join('\n'));

    expect(snapshot.thread.nativeThreadId).toBe('legacy-thread');
    expect(snapshot.thread.workspacePath).toBeNull();
    expect(snapshot.warnings).toContain('Malformed JSONL line skipped: 1');
    expect(snapshot.warnings).toContain('Codex rollout did not include a workspace path.');
    expect(snapshot.messages.map(message => message.role)).toEqual(['user', 'event', 'tool']);
    expect(snapshot.tokenTotals).toMatchObject({ input: 2, output: 3 });
  });
});
