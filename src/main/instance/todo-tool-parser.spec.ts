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

  it('adds a task for each Claude TaskCreate call', () => {
    const first = extractTodoToolItems(toolUse('TaskCreate', {
      subject: 'Create one.txt', description: 'Write the word one', activeForm: 'Creating one.txt',
    }));
    expect(first).toEqual([{ content: 'Create one.txt', status: 'pending', activeForm: 'Creating one.txt' }]);

    const second = extractTodoToolItems(toolUse('TaskCreate', { subject: 'Create two.txt' }), () => first ?? []);
    expect(second).toEqual([
      { content: 'Create one.txt', status: 'pending', activeForm: 'Creating one.txt' },
      { content: 'Create two.txt', status: 'pending' },
    ]);
  });

  it('updates the numbered task for a Claude TaskUpdate call', () => {
    const current = [
      { content: 'One', status: 'pending' as const, activeForm: 'Doing one' },
      { content: 'Two', status: 'pending' as const },
    ];

    expect(extractTodoToolItems(toolUse('TaskUpdate', { taskId: '2', status: 'in_progress' }), () => current)).toEqual([
      { content: 'One', status: 'pending', activeForm: 'Doing one' },
      { content: 'Two', status: 'in_progress' },
    ]);
    expect(extractTodoToolItems(toolUse('TaskUpdate', { taskId: '1', status: 'completed', subject: 'Uno' }), () => current)).toEqual([
      { content: 'Uno', status: 'completed', activeForm: 'Doing one' },
      { content: 'Two', status: 'pending' },
    ]);
    expect(extractTodoToolItems(toolUse('TaskUpdate', { taskId: '1', status: 'deleted' }), () => current)?.[0]?.status).toBe('cancelled');
  });

  it('ignores a TaskUpdate for a task it has not seen, and a TaskCreate with no subject', () => {
    expect(extractTodoToolItems(toolUse('TaskUpdate', { taskId: '3', status: 'completed' }), () => [])).toBeNull();
    expect(extractTodoToolItems(toolUse('TaskUpdate', { status: 'completed' }), () => [{ content: 'One', status: 'pending' }])).toBeNull();
    expect(extractTodoToolItems(toolUse('TaskCreate', { description: 'no subject' }))).toBeNull();
  });

  it('returns null for unrelated tools', () => {
    expect(extractTodoToolItems(toolUse('Read', { path: 'README.md' }))).toBeNull();
  });
});
