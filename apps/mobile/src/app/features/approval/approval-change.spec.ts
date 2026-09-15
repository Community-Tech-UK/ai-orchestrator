import { describe, expect, it } from 'vitest';
import type { MobilePromptDto } from '../../core/models';
import { availableChangeSections } from './approval-change';

const PROMPT: MobilePromptDto = { id: 'p', instanceId: 's', requestId: 'r', kind: 'permission', title: 'Edit file', message: '', createdAt: 0 };

describe('full available approval changes', () => {
  it('keeps content beyond the diff preview limit and preserves action flags', () => {
    const before = 'before\n'.repeat(450) + 'last original line';
    const after = 'after\n'.repeat(450) + 'last changed line';
    const sections = availableChangeSections({ ...PROMPT, toolName: 'Edit', toolInput: { file_path: '/preview/file.ts', old_string: before, new_string: after, replace_all: true } });
    expect(sections[0].content).toBe(before);
    expect(sections[1].content).toBe(after);
    expect(JSON.parse(sections[2].content).replace_all).toBe(true);
  });

  it('includes every valid MultiEdit before/after and unfamiliar input fields', () => {
    const sections = availableChangeSections({ ...PROMPT, toolName: 'MultiEdit', toolInput: { file_path: 'file.ts', edits: [{ old_string: 'first', new_string: 'second' }, null, { old_string: 'third', new_string: 'fourth' }], unfamiliar: 'available detail' } });
    expect(sections.slice(0, 4).map((section) => section.content)).toEqual(['first', 'second', 'third', 'fourth']);
    expect(sections.at(-1)?.content).toContain('available detail');
  });

  it('provides all Write content including its trailing lines', () => {
    const content = 'line\n'.repeat(500) + 'final line';
    expect(availableChangeSections({ ...PROMPT, toolName: 'Write', toolInput: { content } })[0].content).toBe(content);
    expect(availableChangeSections(PROMPT)).toEqual([]);
  });
});
