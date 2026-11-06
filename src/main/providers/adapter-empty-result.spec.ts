import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { observeAdapterRuntimeEvents, type NormalizedAdapterRuntimeEvent } from './adapter-runtime-event-bridge';
import { classifyTurnEnding } from '../cli/turn-ending-classifier';

function observe() {
  const adapter = new EventEmitter();
  const events: NormalizedAdapterRuntimeEvent[] = [];
  observeAdapterRuntimeEvents(adapter, event => events.push(event));
  return { adapter, events, ending: () => events.at(-1)?.event };
}

describe('empty reply producer at the real adapter observation boundary', () => {
  it('classifies a clean response with no text, tools or thinking as empty_result', () => {
    const { adapter, ending } = observe();
    adapter.emit('status', 'busy');
    adapter.emit('complete', { content: '', role: 'assistant', metadata: { stopReason: 'end_turn' } });
    expect(ending()).toMatchObject({ kind: 'complete', turnEnding: { reason: 'empty_result', evidence: 'empty_result' } });
  });

  it.each(['tool_use', 'tool_result'])('does not call a tool-only turn empty (%s)', (kind) => {
    const { adapter, ending } = observe();
    adapter.emit('status', 'busy');
    adapter.emit('output', { id: 't', timestamp: 1, type: kind, content: '', metadata: { id: 'call-1', name: 'Read' } });
    adapter.emit('complete', { content: '', role: 'assistant' });
    expect(ending()).toMatchObject({ turnEnding: { reason: 'completed' } });
  });

  it.each([
    { content: 'Answer.' },
    { content: '', thinking: [{ content: 'Let me think.' }] },
    { content: '', usage: { reasoningTokens: 8 } },
    { content: '', toolCalls: [{ id: 'call', name: 'Read', arguments: {} }] },
    { content: '', degradedReason: 'cancelled' },
    { content: '', metadata: { cancelled: true } },
  ])('preserves nonempty/reasoning/cancelled completion %o', response => {
    const { adapter, ending } = observe();
    adapter.emit('complete', response);
    expect(ending()).toMatchObject({ turnEnding: { reason: 'completed' } });
  });

  it('remembers streamed answer and thinking even when completion contains neither', () => {
    for (const output of [{ content: 'Earlier answer.' }, { content: '', thinking: [{ id: 'think-1', content: 'Thinking.' }] }]) {
      const { adapter, ending } = observe();
      adapter.emit('output', { id: 'a', timestamp: 1, type: 'assistant', ...output });
      adapter.emit('complete', { content: '' });
      expect(ending()).toMatchObject({ turnEnding: { reason: 'completed' } });
    }
  });

  it('clears turn evidence for the next empty reply and excludes interrupted turns', () => {
    const { adapter, ending } = observe();
    adapter.emit('output', { id: 'a', timestamp: 1, type: 'assistant', content: 'Done.' });
    adapter.emit('complete', { content: 'Done.' });
    adapter.emit('status', 'busy');
    adapter.emit('status', 'interrupting');
    adapter.emit('complete', { content: '' });
    expect(ending()).toMatchObject({ turnEnding: { reason: 'completed', autoContinueSuppressed: true } });
    adapter.emit('status', 'busy');
    adapter.emit('complete', { content: '' });
    expect(ending()).toMatchObject({ turnEnding: { reason: 'empty_result' } });
  });

  it('keeps a flagged failed completion an error rather than calling it an empty reply', () => {
    const { adapter, ending } = observe();
    adapter.emit('complete', { content: '', metadata: { turnErrored: true } });
    expect(ending()).toMatchObject({ turnEnding: { reason: 'unknown_error' } });
  });

  it('requires explicit empty-result observation and keeps real failure classifications', () => {
    expect(classifyTurnEnding({ kind: 'complete' }).reason).toBe('completed');
    expect(classifyTurnEnding({ kind: 'complete', metadata: { emptyResult: true } }).reason).toBe('empty_result');
    expect(classifyTurnEnding({ kind: 'complete', metadata: { emptyResult: true, is_error: true } }).reason).toBe('unknown_error');
  });
});
