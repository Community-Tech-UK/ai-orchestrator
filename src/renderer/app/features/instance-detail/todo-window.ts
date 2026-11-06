import type { TodoItem } from '../../../../shared/types/todo.types';
export function windowTodos(todos: readonly TodoItem[], max: number, expanded: boolean): { rows: readonly TodoItem[]; earlier: number; later: number } {
  const size = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 5;
  if (expanded || todos.length <= size) return { rows: todos, earlier: 0, later: 0 };
  const running = todos.findIndex((todo) => todo.status === 'in_progress');
  const unfinished = todos.findIndex((todo) => todo.status === 'pending');
  const focus = running >= 0 ? running : unfinished >= 0 ? unfinished : todos.length;
  const start = Math.max(0, Math.min(focus - 1, todos.length - size));
  return { rows: todos.slice(start, start + size), earlier: start, later: todos.length - start - size };
}
