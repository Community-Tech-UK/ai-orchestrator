import { describe, expect, it } from 'vitest';
import type { TodoItem } from '../../../../shared/types/todo.types';
import { windowTodos } from './todo-window';
const todos = (statuses: TodoItem['status'][]) => statuses.map((status, i) => ({ id: String(i), status } as TodoItem));
describe('task window', () => {
  it('keeps the sixth running task and preceding context in a seven-task list', () => {
    const rows = todos(['completed', 'completed', 'completed', 'completed', 'completed', 'in_progress', 'pending']);
    expect(windowTodos(rows, 5, false)).toEqual({ rows: rows.slice(2), earlier: 2, later: 0 });
  });
  it('shows short lists and every task when expanded', () => {
    const short = todos(['pending', 'pending', 'pending']); expect(windowTodos(short, 5, false).rows).toEqual(short);
    const long = todos(Array.from({ length: 7 }, () => 'completed')); expect(windowTodos(long, 5, true)).toEqual({ rows: long, earlier: 0, later: 0 });
  });
  it('starts near the first unfinished task, or at the final five when all finished', () => {
    const rows = todos(['completed', 'completed', 'completed', 'completed', 'pending', 'pending', 'pending']);
    expect(windowTodos(rows, 5, false).rows).toEqual(rows.slice(2));
    const done = todos(Array.from({ length: 7 }, () => 'completed')); expect(windowTodos(done, 5, false).rows).toEqual(done.slice(2));
  });
});
