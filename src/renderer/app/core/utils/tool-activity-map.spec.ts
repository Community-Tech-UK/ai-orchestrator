import { describe, expect, it } from 'vitest';
import { activityFromOutput, generateActivityStatus, getToolActivity, toolCategory } from './tool-activity-map';
import type { OutputMessage } from '../../../../shared/types/instance.types';

describe('tool activity labels', () => {
  const message = (overrides: Partial<OutputMessage>): OutputMessage => ({
    id: 'output-1', timestamp: 1, type: 'assistant', content: '', ...overrides,
  });

  it('uses the shared plain first-sentence fallback for thinking', () => {
    expect(generateActivityStatus(undefined, 'Checking the **migration** order. Then run checks.'))
      .toBe('Thinking · migration');
    expect(generateActivityStatus(undefined, 'Checking the migration order. Then run checks.'))
      .toBe('Thinking · Checking the migration order');
  });

  it('derives tool activity from the actual output metadata', () => {
    expect(activityFromOutput(message({ type: 'tool_use', metadata: { name: 'Read' } })))
      .toEqual({ activity: 'Reading files', tool: 'Read' });
    expect(activityFromOutput(message({ type: 'tool_use' }))).toBeNull();
    expect(activityFromOutput(message({ type: 'tool_use', metadata: { name: 42 } }))).toBeNull();
  });

  it('derives thinking activity from the newest assistant thinking block', () => {
    expect(activityFromOutput(message({ thinking: [
      { id: 'old', format: 'sdk', content: '**Old topic**' },
      { id: 'new', format: 'sdk', content: 'Checking the migration order. Then run checks.' },
    ] }))).toEqual({ activity: 'Thinking · Checking the migration order', tool: 'thinking' });
  });

  it('does not retain stale thought from an empty newest block or non-assistant message', () => {
    const thinking: NonNullable<OutputMessage['thinking']> = [
      { id: 'old', format: 'sdk', content: '**Old topic**' },
      { id: 'new', format: 'sdk', content: '  ' },
    ];
    expect(activityFromOutput(message({ thinking }))).toBeNull();
    expect(activityFromOutput(message({ thinking: [] }))).toBeNull();
    expect(activityFromOutput(message({ type: 'system', thinking: thinking.slice(0, 1) }))).toBeNull();
    expect(activityFromOutput(message({ content: 'A normal answer' }))).toBeNull();
  });
  it('labels file reads as reading files rather than context gathering', () => {
    expect(getToolActivity('Read')).toBe('Reading files');
    expect(getToolActivity('read')).toBe('Reading files');
    expect(generateActivityStatus('Read')).toBe('Reading files');
  });

  it.each([
    ['Read', 'read'], ['read', 'read'], ['ListDirectory', 'read'], ['Grep', 'search'], ['Glob', 'search'], ['search', 'search'],
    ['Edit', 'edit'], ['Write', 'edit'], ['NotebookEdit', 'edit'], ['move', 'edit'], ['delete', 'edit'], ['apply_patch', 'edit'],
    ['Bash', 'command'], ['execute', 'command'], ['exec_command', 'command'], ['WebFetch', 'web'], ['fetch', 'web'],
    ['Task', 'delegate'], ['TodoRead', 'plan'], ['TodoWrite', 'plan'], ['mcp__my_server__read', 'server'], ['unknown', 'other'],
  ])('categorises %s as %s', (name, category) => {
    expect(toolCategory(name)).toBe(category);
  });
});

describe('activity from live output', () => {
  const base = { id: 'message', timestamp: 1, content: '' };
  it('uses the last thinking block as a plain bounded headline', () => {
    expect(activityFromOutput({ ...base, type: 'assistant', thinking: [
      { id: 'old', content: '**Old thought**', format: 'structured' }, { id: 'new', content: 'Checking migration order. More detail.', format: 'structured' },
    ] })).toEqual({ activity: 'Thinking · Checking migration order', tool: 'thinking' });
  });
  it('uses the normal tool label for the next tool call and leaves plain replies alone', () => {
    expect(activityFromOutput({ ...base, type: 'tool_use', metadata: { name: 'Read' } })).toEqual({ activity: 'Reading files', tool: 'Read' });
    expect(activityFromOutput({ ...base, type: 'assistant', content: 'Final answer' })).toBeNull();
  });
});
