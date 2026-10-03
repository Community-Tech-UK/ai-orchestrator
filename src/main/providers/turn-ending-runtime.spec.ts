import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { mapAdapterRuntimeEvent, observeAdapterRuntimeEvents } from './adapter-runtime-event-bridge';
import { isCollapsedReasoning } from '../cli/adapters/reasoning-collapse';
import { ProviderRuntimeEventSchema } from '@contracts/schemas/provider-runtime-events';
import { getLogManager } from '../logging/logger';

describe('safe shared completion diagnostics', () => {
  it('logs non-ACP completion metadata and hashes instead of source material', () => {
    const adapter = Object.assign(new EventEmitter(), { getName: () => 'Codex', getConfig: () => ({ model: 'fixture-model' }) });
    observeAdapterRuntimeEvents(adapter, () => undefined);
    adapter.emit('output', { type: 'assistant', content: '', thinking: [{ content: 'Hmm. '.repeat(40) }] });
    adapter.emit('complete', { content: 'private fixture source', usage: { outputTokens: 3, reasoningTokens: 40 }, metadata: { stopReason: 'max_tokens' } });
    const entry = getLogManager().getRecentLogs({ subsystem: 'ProviderTurnEnding', limit: 1 })[0];
    expect(entry?.data).toMatchObject({ adapter: 'Codex', model: 'fixture-model', stopReason: 'max_tokens', outputTokens: 3, reasoningTokens: 40, classifierReason: 'max_output' });
    expect(entry?.data?.['collapsedTailHash']).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(entry)).not.toContain('private fixture source');
    expect(JSON.stringify(entry)).not.toContain('Hmm.');
  });
});

describe('provider turn-ending runtime contract', () => {
  it('clears native retry suppression when the provider explicitly gives up', () => {
    const adapter = new EventEmitter();
    const events: unknown[] = [];
    observeAdapterRuntimeEvents(adapter, ({ event }) => events.push(event));
    adapter.emit('status', 'busy');
    adapter.emit('output', { type: 'system', content: 'Retrying.', metadata: { willRetry: true } });
    adapter.emit('output', { type: 'system', content: 'Stopped retrying.', metadata: { willRetry: false } });
    adapter.emit('error', Object.assign(new Error('provider unavailable'), { statusCode: 503 }));
    expect(events.at(-1)).toMatchObject({ kind: 'error', turnEnding: { reason: 'retryable' } });
    expect((events.at(-1) as { turnEnding: { providerRetrying?: boolean } }).turnEnding.providerRetrying).not.toBe(true);
  });
  it.each([{ type: 'undefined' }, [null, { content: 4 }, { content: 'ordinary thought' }]])('ignores untrusted thinking shapes without breaking actual completion delivery', (thinking) => {
    const adapter = new EventEmitter();
    const events: unknown[] = [];
    observeAdapterRuntimeEvents(adapter, ({ event }) => events.push(event));
    adapter.emit('complete', { content: 'Ready.', thinking });
    expect(events.at(-1)).toMatchObject({ kind: 'complete', turnEnding: { reason: 'completed' } });
  });

  it('retains collapse evidence from native string thinking', () => {
    const adapter = new EventEmitter();
    const events: unknown[] = [];
    observeAdapterRuntimeEvents(adapter, ({ event }) => events.push(event));
    adapter.emit('complete', { content: '', thinking: 'Hmm. '.repeat(40) });
    expect(events.at(-1)).toMatchObject({ kind: 'complete', turnEnding: { reason: 'max_output', reasoningCollapsed: true } });
  });

  it('retains native string thinking streamed before the terminal response', () => {
    const adapter = new EventEmitter();
    const events: unknown[] = [];
    observeAdapterRuntimeEvents(adapter, ({ event }) => events.push(event));
    adapter.emit('output', { type: 'assistant', content: '', thinking: 'Hmm. '.repeat(40) });
    adapter.emit('complete', { content: '' });
    expect(events.at(-1)).toMatchObject({ turnEnding: { reason: 'max_output', reasoningCollapsed: true } });
  });

  it.each([
    ['max_tokens', 'max_output'], ['refusal', 'content_filter'], ['length', 'max_output'],
    ['content-filter', 'content_filter'], ['end_turn', 'completed'],
  ])('classifies native %s on the common adapter path', (stopReason, reason) => {
    const mapped = mapAdapterRuntimeEvent('complete', [{ content: '', metadata: { stopReason } }]);
    expect(mapped?.event).toMatchObject({ turnEnding: { reason } });
    expect(ProviderRuntimeEventSchema.parse(mapped?.event)).toMatchObject({ turnEnding: { reason } });
  });

  it('retains turn thinking and read provenance from streamed output for non-ACP providers', () => {
    const adapter = new EventEmitter();
    const events: unknown[] = [];
    observeAdapterRuntimeEvents(adapter, ({ event }) => events.push(event));
    adapter.emit('status', 'busy');
    adapter.emit('tool_use', { id: 'read-1', name: 'Read', arguments: { path: '/fixture.txt' } });
    adapter.emit('tool_result', { id: 'read-1', name: 'Read', result: 'fixture' });
    adapter.emit('output', { id: 'answer', type: 'assistant', content: '', thinking: [{ content: 'Hmm. '.repeat(40) }] });
    adapter.emit('complete', { content: '', usage: { outputTokens: 0, reasoningTokens: 32004 } });
    expect(events.at(-1)).toMatchObject({ turnEnding: { reason: 'max_output', reasoningCollapsed: true } });
    adapter.emit('status', 'busy');
    adapter.emit('complete', { content: 'Ready.' });
    expect(events.at(-1)).toMatchObject({ turnEnding: { reason: 'completed' } });
  });

  it('classifies error streams and suppresses recovery while the provider owns retries', () => {
    expect(mapAdapterRuntimeEvent('error', [Object.assign(new Error('HTTP 401 unauthorized'), { providerRetrying: true })])?.event)
      .toMatchObject({ turnEnding: { reason: 'auth', providerRetrying: true, autoContinueSuppressed: true } });
    expect(mapAdapterRuntimeEvent('error', [new Error('ContentFilterError')])?.event)
      .toMatchObject({ turnEnding: { reason: 'content_filter' } });
  });

  it.each([
    'Hmm. '.repeat(40),
    Array.from({ length: 40 }, (_, i) => i % 2 ? 'Wait.' : 'Hmm.').join('\n'),
    'Hmm.\n'.repeat(40) + 'Tool result appended.',
  ])('detects collapse beyond identical trailing lines', (thinking) => {
    expect(isCollapsedReasoning(thinking)).toBe(true);
  });

  it('recovers an actual foreground tool result with no reply, including clean process exit', () => {
    const adapter = new EventEmitter();
    const events: unknown[] = [];
    observeAdapterRuntimeEvents(adapter, ({ event }) => events.push(event));
    adapter.emit('status', 'busy');
    adapter.emit('output', { id: 'answer', type: 'assistant', content: 'I am reading.', metadata: { accumulatedContent: 'I am reading.' } });
    adapter.emit('output', { type: 'tool_use', content: '', metadata: { id: 'read-1', name: 'Read', input: { path: '/fixture.txt' } } });
    adapter.emit('output', { type: 'tool_result', content: 'fixture', metadata: { tool_use_id: 'read-1', name: 'Read' } });
    // ACP/CLI finalization can repeat an earlier narration bubble. That is
    // not a reply to the latest tool result.
    adapter.emit('output', { id: 'answer', type: 'assistant', content: 'I am reading.', metadata: { accumulatedContent: 'I am reading.' } });
    adapter.emit('exit', 0, null);
    expect(events.at(-1)).toMatchObject({ kind: 'exit', turnEnding: { reason: 'dangling_tool_result' } });
  });

  it.each(['background', 'replied', 'tool_calls', 'cancelled', 'unmatched'])('does not recover a %s tool boundary', (variant) => {
    const adapter = new EventEmitter();
    const events: unknown[] = [];
    observeAdapterRuntimeEvents(adapter, ({ event }) => events.push(event));
    adapter.emit('status', 'busy');
    if (variant !== 'unmatched') adapter.emit('tool_use', { id: 'read-1', name: 'Read', arguments: { background: variant === 'background' } });
    adapter.emit('tool_result', { id: 'read-1', name: 'Read', result: 'fixture' });
    if (variant === 'replied') adapter.emit('output', { id: 'answer', type: 'assistant', content: 'The file is ready.' });
    adapter.emit('complete', { content: '', degradedReason: variant === 'cancelled' ? 'cancelled' : undefined, metadata: { stopReason: variant === 'tool_calls' ? 'tool_calls' : 'end_turn' } });
    expect(events.at(-1)).toMatchObject({ turnEnding: { reason: 'completed' } });
  });

  it('accepts a fresh completion-only answer after a foreground tool result', () => {
    const adapter = new EventEmitter();
    const events: unknown[] = [];
    observeAdapterRuntimeEvents(adapter, ({ event }) => events.push(event));
    adapter.emit('tool_use', { id: 'read-1', name: 'Read', arguments: {} });
    adapter.emit('tool_result', { id: 'read-1', name: 'Read', result: 'fixture' });
    adapter.emit('complete', { content: 'The file is ready.' });
    expect(events.at(-1)).toMatchObject({ turnEnding: { reason: 'completed' } });
  });

  it('does not treat repeated completion narration as a fresh tool reply', () => {
    const adapter = new EventEmitter();
    const events: unknown[] = [];
    observeAdapterRuntimeEvents(adapter, ({ event }) => events.push(event));
    adapter.emit('output', { id: 'answer', type: 'assistant', content: 'I am reading.' });
    adapter.emit('tool_use', { id: 'read-1', name: 'Read', arguments: {} });
    adapter.emit('tool_result', { id: 'read-1', name: 'Read', result: 'fixture' });
    adapter.emit('complete', { content: 'I am reading.' });
    expect(events.at(-1)).toMatchObject({ turnEnding: { reason: 'dangling_tool_result' } });
  });

  it('keeps denied native doom-loop endings notice-only until actual progress resumes', () => {
    const adapter = new EventEmitter();
    const events: unknown[] = [];
    observeAdapterRuntimeEvents(adapter, ({ event }) => events.push(event));
    adapter.emit('tool_use', { id: 'bash-1', name: 'Bash', arguments: {} });
    adapter.emit('tool_result', { id: 'bash-1', name: 'Bash', result: 'blocked' });
    adapter.emit('output', { type: 'system', content: 'Repeated call blocked.', metadata: { doomLoopBlocked: true, transport: 'acp' } });
    adapter.emit('complete', { content: '' });
    expect(events.at(-1)).toMatchObject({ turnEnding: { reason: 'doom_loop' } });
    adapter.emit('tool_use', { id: 'read-2', name: 'Read', arguments: {} });
    adapter.emit('tool_result', { id: 'read-2', name: 'Read', result: 'fixture' });
    adapter.emit('complete', { content: 'The alternate read succeeded.' });
    expect(events.at(-1)).toMatchObject({ turnEnding: { reason: 'completed' } });
  });
});
