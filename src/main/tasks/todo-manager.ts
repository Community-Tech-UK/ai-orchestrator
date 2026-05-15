/**
 * TODO Manager - Session-scoped task management
 *
 * Manages TODO lists per session, allowing AI to track and update tasks
 * during complex operations.
 */

import { EventEmitter } from 'events';
import {
  TodoItem,
  TodoList,
  TodoStats,
  CreateTodoRequest,
  UpdateTodoRequest,
  createTodoItem,
  calculateTodoStats,
  sortTodos,
  filterOldCompletedTodos,
  parseTodoInput,
  ParsedTodoInput,
} from '../../shared/types/todo.types';

export interface TodoManagerEvents {
  'todo:created': (sessionId: string, item: TodoItem) => void;
  'todo:updated': (sessionId: string, item: TodoItem) => void;
  'todo:deleted': (sessionId: string, todoId: string) => void;
  'todos:changed': (sessionId: string, list: TodoList) => void;
  'todos:cleared': (sessionId: string) => void;
}

export class TodoManager extends EventEmitter {
  // Session ID -> TODO items
  private todosBySession: Map<string, TodoItem[]> = new Map();

  constructor() {
    super();
  }

  /**
   * Get all TODOs for a session
   */
  getTodos(sessionId: string): TodoItem[] {
    return this.todosBySession.get(sessionId) || [];
  }

  /**
   * Get TODO list with stats for a session
   */
  getTodoList(sessionId: string): TodoList {
    const items = sortTodos(this.getTodos(sessionId));
    return {
      sessionId,
      items,
      stats: calculateTodoStats(items),
    };
  }

  /**
   * Get a specific TODO by ID
   */
  getTodo(sessionId: string, todoId: string): TodoItem | undefined {
    const items = this.getTodos(sessionId);
    return items.find((item) => item.id === todoId);
  }

  /**
   * Create a new TODO
   */
  createTodo(sessionId: string, request: CreateTodoRequest): TodoItem {
    const item = createTodoItem(sessionId, request);

    const items = this.todosBySession.get(sessionId) || [];
    items.push(item);
    this.todosBySession.set(sessionId, items);

    this.emit('todo:created', sessionId, item);
    this.emitListChanged(sessionId);

    return item;
  }

  /**
   * Update an existing TODO
   */
  updateTodo(sessionId: string, request: UpdateTodoRequest): TodoItem | undefined {
    const items = this.todosBySession.get(sessionId);
    if (!items) return undefined;

    const index = items.findIndex((item) => item.id === request.id);
    if (index === -1) return undefined;

    const item = items[index];
    const now = Date.now();

    // Apply updates
    if (request.content !== undefined) {
      item.content = request.content;
    }
    if (request.activeForm !== undefined) {
      item.activeForm = request.activeForm;
    }
    if (request.status !== undefined) {
      const oldStatus = item.status;
      item.status = request.status;

      // Track completion time
      if (request.status === 'completed' && oldStatus !== 'completed') {
        item.completedAt = now;
      } else if (request.status !== 'completed') {
        item.completedAt = undefined;
      }
    }
    if (request.priority !== undefined) {
      item.priority = request.priority;
    }

    item.updatedAt = now;

    this.emit('todo:updated', sessionId, item);
    this.emitListChanged(sessionId);

    return item;
  }

  /**
   * Delete a TODO
   */
  deleteTodo(sessionId: string, todoId: string): boolean {
    const items = this.todosBySession.get(sessionId);
    if (!items) return false;

    const index = items.findIndex((item) => item.id === todoId);
    if (index === -1) return false;

    items.splice(index, 1);
    this.todosBySession.set(sessionId, items);

    this.emit('todo:deleted', sessionId, todoId);
    this.emitListChanged(sessionId);

    return true;
  }

  /**
   * Bulk write TODOs (replaces all TODOs for a session)
   * This is the format used by Claude's TodoWrite tool
   */
  writeTodos(
    sessionId: string,
    todos: Array<{ content: string; status: string; activeForm?: string }>
  ): TodoList {
    const existingItems = this.todosBySession.get(sessionId) || [];
    const existingByContent = new Map<string, TodoItem>();

    // Index existing items by content for potential reuse
    for (const item of existingItems) {
      existingByContent.set(item.content, item);
    }

    const newItems: TodoItem[] = [];
    const now = Date.now();

    for (const input of todos) {
      const parsed = parseTodoInput(input);

      // Check if we have an existing item with the same content
      const existing = existingByContent.get(parsed.content);

      if (existing) {
        // Update existing item
        const oldStatus = existing.status;
        existing.status = parsed.status;
        existing.activeForm = parsed.activeForm;
        existing.updatedAt = now;

        if (parsed.status === 'completed' && oldStatus !== 'completed') {
          existing.completedAt = now;
        } else if (parsed.status !== 'completed') {
          existing.completedAt = undefined;
        }

        newItems.push(existing);
      } else {
        // Create new item
        const item = createTodoItem(sessionId, {
          content: parsed.content,
          activeForm: parsed.activeForm,
          status: parsed.status,
        });
        newItems.push(item);
      }
    }

    this.todosBySession.set(sessionId, newItems);
    this.emitListChanged(sessionId);

    return this.getTodoList(sessionId);
  }

  /**
   * Mark a TODO as in progress
   */
  startTodo(sessionId: string, todoId: string): TodoItem | undefined {
    return this.updateTodo(sessionId, { id: todoId, status: 'in_progress' });
  }

  /**
   * Mark a TODO as completed
   */
  completeTodo(sessionId: string, todoId: string): TodoItem | undefined {
    return this.updateTodo(sessionId, { id: todoId, status: 'completed' });
  }

  /**
   * Mark a TODO as cancelled
   */
  cancelTodo(sessionId: string, todoId: string): TodoItem | undefined {
    return this.updateTodo(sessionId, { id: todoId, status: 'cancelled' });
  }

  /**
   * Clear all TODOs for a session
   */
  clearTodos(sessionId: string): void {
    this.todosBySession.delete(sessionId);
    this.emit('todos:cleared', sessionId);
  }

  /**
   * Clean up old completed TODOs
   */
  cleanupOldTodos(sessionId: string, maxAgeMs?: number): void {
    const items = this.getTodos(sessionId);
    const filtered = filterOldCompletedTodos(items, maxAgeMs);

    if (filtered.length !== items.length) {
      this.todosBySession.set(sessionId, filtered);
      this.emitListChanged(sessionId);
    }
  }

  /**
   * Get stats for a session
   */
  getStats(sessionId: string): TodoStats {
    return calculateTodoStats(this.getTodos(sessionId));
  }

  /**
   * Get the currently in-progress TODO (if any)
   */
  getCurrentTodo(sessionId: string): TodoItem | undefined {
    const items = this.getTodos(sessionId);
    return items.find((item) => item.status === 'in_progress');
  }

  /**
   * Get all sessions with TODOs
   */
  getSessionsWithTodos(): string[] {
    return Array.from(this.todosBySession.keys());
  }

  /**
   * Copy TODOs from one session to another (for forking)
   */
  copyTodos(fromSessionId: string, toSessionId: string): void {
    const items = this.getTodos(fromSessionId);
    if (items.length === 0) return;

    const now = Date.now();
    const newItems = items.map((item) => ({
      ...item,
      id: `todo_${now}_${Math.random().toString(36).substring(2, 9)}`,
      sessionId: toSessionId,
      createdAt: now,
      updatedAt: now,
    }));

    this.todosBySession.set(toSessionId, newItems);
    this.emitListChanged(toSessionId);
  }

  /**
   * Emit list changed event
   */
  private emitListChanged(sessionId: string): void {
    this.emit('todos:changed', sessionId, this.getTodoList(sessionId));
  }

  /**
   * Serialize all TODOs (for persistence)
   */
  serialize(): Map<string, TodoItem[]> {
    return new Map(this.todosBySession);
  }

  /**
   * Restore from serialized data
   */
  restore(data: Map<string, TodoItem[]> | Record<string, TodoItem[]>): void {
    if (data instanceof Map) {
      this.todosBySession = new Map(data);
    } else {
      this.todosBySession = new Map(Object.entries(data));
    }
  }
}

// Singleton instance
let todoManager: TodoManager | null = null;

export function getTodoManager(): TodoManager {
  if (!todoManager) {
    todoManager = new TodoManager();
  }
  return todoManager;
}
