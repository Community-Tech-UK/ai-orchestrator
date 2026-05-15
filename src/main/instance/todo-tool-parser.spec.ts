import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import { extractTodoToolItems } from './todo-tool-parser';

function toolUse(name: string, input: unknown): OutputMessage {
  return {
    id: 'tool-1',
    timestamp: Date.now(),
    type: 'tool_use',
    content: '',
    metadata: { name, input },
  };
}

describe('extractTodoToolItems', () => {
  it('extracts Claude TodoWrite todos', () => {
    const items = extractTodoToolItems(toolUse('TodoWrite', {
      todos: [
        { content: 'Read files', status: 'completed' },
        { content: 'Write summary', status: 'in_progress', activeForm: 'Writing summary' },
      ],
    }));

    expect(items).toEqual([
      { content: 'Read files', status: 'completed' },
      { content: 'Write summary', status: 'in_progress', activeForm: 'Writing summary' },
    ]);
  });

  it('extracts Codex update_plan steps', () => {
    const items = extractTodoToolItems(toolUse('update_plan', {
      plan: [
        { step: 'Inspect current UI', status: 'completed' },
        { step: 'Add progress panel', status: 'pending' },
      ],
    }));

    expect(items).toEqual([
      { content: 'Inspect current UI', status: 'completed' },
      { content: 'Add progress panel', status: 'pending' },
    ]);
  });

  it('parses stringified tool arguments', () => {
    const items = extractTodoToolItems({
      id: 'tool-2',
      timestamp: Date.now(),
      type: 'tool_use',
      content: '',
      metadata: {
        name: 'update_plan',
        arguments: JSON.stringify({
          plan: [{ step: 'Run verification', status: 'in-progress' }],
        }),
      },
    });

    expect(items).toEqual([
      { content: 'Run verification', status: 'in_progress' },
    ]);
  });

  it('returns null for unrelated tools', () => {
    expect(extractTodoToolItems(toolUse('Read', { path: 'README.md' }))).toBeNull();
  });
});
