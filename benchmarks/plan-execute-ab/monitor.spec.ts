import { describe, expect, it } from 'vitest';
import { createTakeoverMonitor } from './monitor';

function assistantEvent(content: Record<string, unknown>[]): Record<string, unknown> {
  return { type: 'assistant', message: { content } };
}

function toolResult(isError: boolean): Record<string, unknown> {
  return { type: 'user', message: { content: [{ type: 'tool_result', is_error: isError }] } };
}

describe('takeover monitor (arm F)', () => {
  it('aborts after 2 failed test runs without an edit between them', () => {
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 15 });
    monitor.onEvent(assistantEvent([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run test:quiet' } }]));
    const first = monitor.onEvent(toolResult(true));
    expect(first.abort).toBe(false);
    monitor.onEvent(assistantEvent([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run test:quiet' } }]));
    const second = monitor.onEvent(toolResult(true));
    expect(second.abort).toBe(true);
    expect(second.reason).toContain('2 failed test runs');
  });

  it('resets the failed-test count after a file edit', () => {
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 15 });
    monitor.onEvent(assistantEvent([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]));
    monitor.onEvent(toolResult(true));
    monitor.onEvent(assistantEvent([{ type: 'tool_use', name: 'Edit', input: {} }]));
    expect(monitor.snapshot().failedTestRunsSinceEdit).toBe(0);
  });

  it('treats real tool_use edit events as progress and never fires takeover mid-editing', () => {
    // Regression: Claude stream events shape edits as {type:'tool_use', name:'Edit'}.
    // Matching only block.type against Edit/Write made 15 editing turns look
    // like "15 turns with no edit" and aborted a run that was making progress.
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 15 });
    let decision = { abort: false, reason: '' };
    for (let i = 0; i < 30; i += 1) {
      decision = monitor.onEvent(assistantEvent([{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/x.ts' } }]));
    }
    expect(decision.abort).toBe(false);
    expect(monitor.snapshot().turnsSinceEdit).toBe(0);
  });

  it('counts Write, NotebookEdit and MultiEdit tool_use names as progress', () => {
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 3 });
    for (const name of ['Write', 'NotebookEdit', 'MultiEdit']) {
      monitor.onEvent(assistantEvent([{ type: 'text', text: 'working' }]));
      monitor.onEvent(assistantEvent([{ type: 'text', text: 'working' }]));
      monitor.onEvent(assistantEvent([{ type: 'tool_use', name, input: {} }]));
      expect(monitor.snapshot().turnsSinceEdit).toBe(0);
    }
    expect(monitor.onEvent(assistantEvent([{ type: 'text', text: 'ok' }])).abort).toBe(false);
  });

  it('still accepts the flat {type: "Edit"} legacy fixture shape', () => {
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 15 });
    monitor.onEvent(assistantEvent([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]));
    monitor.onEvent(toolResult(true));
    monitor.onEvent(assistantEvent([{ type: 'Edit', name: 'Edit', input: {} }]));
    expect(monitor.snapshot().failedTestRunsSinceEdit).toBe(0);
    expect(monitor.snapshot().turnsSinceEdit).toBe(0);
  });

  it('aborts after 15 turns with no edit', () => {
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 15 });
    let decision = { abort: false, reason: '' };
    for (let i = 0; i < 15; i += 1) {
      decision = monitor.onEvent(assistantEvent([{ type: 'text', text: 'thinking' }]));
    }
    expect(decision.abort).toBe(true);
    expect(decision.reason).toContain('15 turns with no edit');
  });

  it('does not count a passing test run as a failure', () => {
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 15 });
    for (let i = 0; i < 4; i += 1) {
      monitor.onEvent(assistantEvent([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]));
      monitor.onEvent(toolResult(false));
    }
    expect(monitor.snapshot().failedTestRunsSinceEdit).toBe(0);
    expect(monitor.onEvent(assistantEvent([{ type: 'text', text: 'ok' }])).abort).toBe(false);
  });

  it('counts failed test runs when one assistant message batches several Bash calls', () => {
    // Regression: one boolean per message was overwritten by the non-test Bash
    // call, and results were not matched to calls by tool_use_id, so two failed
    // `npm test` runs batched with `ls` never triggered the takeover.
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 15 });
    const batch = (testId: string, listId: string): Record<string, unknown> => ({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: testId, name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: listId, name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const results = (testId: string, listId: string, testError: boolean): Record<string, unknown> => ({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: testId, is_error: testError },
          { type: 'tool_result', tool_use_id: listId, is_error: false },
        ],
      },
    });
    monitor.onEvent(batch('t1', 'l1'));
    const first = monitor.onEvent(results('t1', 'l1', true));
    expect(first.abort).toBe(false);
    expect(monitor.snapshot().failedTestRunsSinceEdit).toBe(1);
    monitor.onEvent(batch('t2', 'l2'));
    const second = monitor.onEvent(results('t2', 'l2', true));
    expect(second.abort).toBe(true);
    expect(second.reason).toContain('2 failed test runs');
  });

  it('ignores tool results that do not belong to a pending test call', () => {
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 15 });
    monitor.onEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    });
    monitor.onEvent({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'r1', is_error: true },
          { type: 'tool_result', tool_use_id: 't1', is_error: true },
        ],
      },
    });
    expect(monitor.snapshot().failedTestRunsSinceEdit).toBe(1);
  });

  it('counts one turn per assistant message, not per content-block event', () => {
    // Regression (verifier round): real Claude stream-json emits one event per
    // content block, all sharing message.id. Counting events made five actual
    // turns look like fifteen and aborted the run mid-progress ("15 turns with
    // no edit"), spending the remaining budget on Opus. Shapes mirror
    // agent-cli.spec.ts / parseClaudeStream.
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 15 });
    let decision = { abort: false, reason: '' };
    for (let turn = 0; turn < 5; turn += 1) {
      const blocks: Record<string, unknown>[] = [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: `tu_${turn}`, name: 'Read', input: { file_path: 'src/x.ts' } },
      ];
      for (const block of blocks) {
        decision = monitor.onEvent({ type: 'assistant', message: { id: `msg_${turn}`, content: [block] } });
      }
    }
    expect(decision.abort).toBe(false);
    expect(monitor.snapshot().turnsSinceEdit).toBe(5);
  });

  it('does not re-count later blocks of a message after its edit resets progress', () => {
    const monitor = createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 2 });
    monitor.onEvent({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'text', text: 'thinking' }] } });
    // Same message delivers the edit and trailing text: one turn, and the edit
    // resets the counter — the trailing block must not re-count it.
    monitor.onEvent({ type: 'assistant', message: { id: 'msg_b', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } });
    monitor.onEvent({ type: 'assistant', message: { id: 'msg_b', content: [{ type: 'text', text: 'done' }] } });
    expect(monitor.snapshot().turnsSinceEdit).toBe(0);
    // The next distinct message is turn 1 since the edit; its second block
    // event is still turn 1 (limit 2 stays clear).
    monitor.onEvent({ type: 'assistant', message: { id: 'msg_c', content: [{ type: 'text', text: 'x' }] } });
    const decision = monitor.onEvent({ type: 'assistant', message: { id: 'msg_c', content: [{ type: 'text', text: 'y' }] } });
    expect(decision.abort).toBe(false);
    expect(monitor.snapshot().turnsSinceEdit).toBe(1);
  });
});
