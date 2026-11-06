import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import { registerExactSecretValue, _resetExactSecretValuesForTesting } from '../security/secret-detector';
import { continuityEntryToOutputMessage, outputMessagesToContinuityEntries } from './continuity-message-projection';
import { projectSessionTranscript } from './session-transcript-view';
const message = (seq: number, type: OutputMessage['type'] = 'user', content = `row ${seq}`, metadata?: OutputMessage['metadata']): OutputMessage => ({ id: String(seq), timestamp: seq, type, content, metadata });
describe('session transcript view', () => {
  it('pages newest first without overlap and keeps transcript positions', () => {
    const rows = Array.from({ length: 8 }, (_, i) => message(i));
    const first = projectSessionTranscript(rows, { limit: 3 });
    expect(first.items.map((i) => i.seq)).toEqual([7, 6, 5]);
    const second = projectSessionTranscript(rows, { limit: 3, before: first.olderCursor! });
    expect(second.items.map((i) => i.seq)).toEqual([4, 3, 2]);
  });
  it('filters invisible outcomes in both views and labels provenance', () => {
    const rows = [message(0), message(1, 'system'), message(2, 'tool_outcome'), message(3, 'tool_use', 'input', { name: 'Read' }), message(4, 'system', 'directions', { internalInput: { actor: 'harness', source: 'compaction-continuity' } }), message(5, 'user', 'delivery', { crossSessionMessage: { sourceInstanceId: 'other', sourceDisplayName: 'Other', hopCount: 0 } })];
    expect(projectSessionTranscript(rows, {}).items.map((i) => i.source)).toEqual(['other-session', 'harness', 'user']);
    const activity = projectSessionTranscript(rows, { view: 'activity' });
    expect(activity.items.some((i) => i.role === 'tool_outcome')).toBe(false);
    expect(activity.items.find((i) => i.role === 'tool_use')?.text).toContain('Read');
  });
  it('keeps the tool name in the activity view after a continuity round trip', () => {
    const rows = [message(0, 'tool_use', '', { name: 'Read', input: { file_path: '/example.txt' } })];
    const before = projectSessionTranscript(rows, { view: 'activity' }).items[0].text;
    expect(before).toBe('Read: {"file_path":"/example.txt"}');

    const restored = outputMessagesToContinuityEntries(rows).map(continuityEntryToOutputMessage);
    expect(restored[0].metadata?.['toolName']).toBe('Read');
    const after = projectSessionTranscript(restored, { view: 'activity' }).items[0].text;
    expect(after).toBe(before);
  });
  it.each(['isCompactionBoundary', 'threadCompacted', 'kind'])('starts before the newest %s reset', (key) => {
    const rows = [message(0), message(1, 'system', 'reset', { [key]: key === 'kind' ? 'session-boundary' : true }), message(2)];
    expect(projectSessionTranscript(rows, { from: 'before-last-compaction' })).toMatchObject({ items: [{ seq: 0 }], compactions: [1] });
    expect(projectSessionTranscript([message(0)], { from: 'before-last-compaction' })).toMatchObject({ items: [{ seq: 0 }], compactions: [] });
  });
  it.each([
    ['isCompactionBoundary', 'threadCompacted', 'kind'],
    ['threadCompacted', 'kind', 'isCompactionBoundary'],
    ['kind', 'isCompactionBoundary', 'threadCompacted'],
  ])('uses the newest boundary in a mixture of reset kinds: %j', (...kinds) => {
    const rows = [message(0)];
    for (const [index, kind] of kinds.entries()) {
      rows.push(message(index * 2 + 1, 'system', 'reset', { [kind]: kind === 'kind' ? 'session-boundary' : true }));
      rows.push(message(index * 2 + 2));
    }
    const page = projectSessionTranscript(rows, { from: 'before-last-compaction', limit: 2 });
    expect(page.compactions).toEqual([1, 3, 5]);
    expect(page.items.map((item) => item.seq)).toEqual([4, 2]);
    expect(page.olderCursor).toBe(2);
    expect(projectSessionTranscript(rows, { before: page.olderCursor! }).items.map((item) => item.seq)).toEqual([0]);
  });
  it('redacts before truncating and enforces item and page caps', () => {
    const placeholder = 'OBVIOUS_TEST_SECRET_PLACEHOLDER';
    registerExactSecretValue(placeholder, 'placeholder');
    try {
      const page = projectSessionTranscript(Array.from({ length: 10 }, (_, i) => message(i, 'assistant', placeholder + 'x'.repeat(9000))), { limit: 50 });
      expect(page.items.every((i) => i.truncated && i.text.length <= 4000)).toBe(true);
      expect(page.items.map((i) => i.text).join('').length).toBeLessThanOrEqual(24000);
      expect(page.items[0].text).toContain('[REDACTED:placeholder]');
      expect(page.truncated).toBe(true);
      expect(page.olderCursor).not.toBeNull();
    } finally { _resetExactSecretValuesForTesting(); }
  });
  it.each([5000, 25000])('caps an oversized tool name (%s characters) without losing its cursor', (length) => {
    const rows = [message(0), message(1, 'tool_use', 'input', { name: 'n'.repeat(length) })];
    const page = projectSessionTranscript(rows, { view: 'activity', limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ seq: 1, truncated: true });
    expect(page.items[0].text.length).toBeLessThanOrEqual(4000);
    expect(page.olderCursor).toBe(1);
    expect(projectSessionTranscript(rows, { view: 'activity', before: page.olderCursor! }).items).toMatchObject([{ seq: 0 }]);
  });
  it('redacts overlapping registered values at the actual transcript egress boundary', () => {
    const full = 'OBVIOUS_TEST_SECRET_PLACEHOLDER_FOR_AUDIT_ONLY';
    registerExactSecretValue(full, 'full_placeholder');
    registerExactSecretValue('TEST_SECRET', 'inner_placeholder');
    try {
      const page = projectSessionTranscript([message(0, 'assistant', `before ${full} after`)], {});
      expect(page.items[0].text).toBe('before [REDACTED:full_placeholder] after');
    } finally { _resetExactSecretValuesForTesting(); }
  });
});
