import { describe, expect, it } from 'vitest';
import { TodoManager } from './todo-manager';

describe('TodoManager', () => {
  it('sets completedAt when writeTodos moves an existing item to completed', () => {
    const manager = new TodoManager();
    manager.writeTodos('session-1', [
      { content: 'Draft document', status: 'in_progress' },
    ]);

    expect(manager.getTodos('session-1')[0]?.completedAt).toBeUndefined();

    manager.writeTodos('session-1', [
      { content: 'Draft document', status: 'completed' },
    ]);

    const item = manager.getTodos('session-1')[0];
    expect(item?.status).toBe('completed');
    expect(item?.completedAt).toEqual(expect.any(Number));
  });

  it('sets completedAt when writeTodos creates an already-completed item', () => {
    const manager = new TodoManager();

    manager.writeTodos('session-1', [
      { content: 'Draft document', status: 'completed' },
    ]);

    const item = manager.getTodos('session-1')[0];
    expect(item?.status).toBe('completed');
    expect(item?.completedAt).toEqual(expect.any(Number));
  });

  it('preserves completedAt when copying todos to a new session id', () => {
    const manager = new TodoManager();
    manager.writeTodos('temporary-session', [
      { content: 'Draft document', status: 'completed' },
    ]);

    const original = manager.getTodos('temporary-session')[0];
    manager.copyTodos('temporary-session', 'provider-session');

    const copied = manager.getTodos('provider-session')[0];
    expect(copied?.status).toBe('completed');
    expect(copied?.completedAt).toBe(original?.completedAt);
  });
});
