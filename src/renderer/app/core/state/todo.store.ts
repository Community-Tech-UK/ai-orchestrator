/**
 * TODO Store - State management for session-scoped TODOs
 *
 * Manages TODO lists per session, providing reactive state for
 * displaying AI task progress.
 */

import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { ElectronIpcService } from '../services/electron-ipc.service';
import type { TodoItem, TodoList, TodoStats, TodoStatus, TodoPriority } from '../../../../shared/types/todo.types';

@Injectable({ providedIn: 'root' })
export class TodoStore implements OnDestroy {
  private ipcService = inject(ElectronIpcService);
  private unsubscribe: (() => void) | null = null;

  // State
  private _currentSessionId = signal<string | null>(null);
  private _todos = signal<TodoItem[]>([]);
  private _stats = signal<TodoStats>({
    total: 0,
    pending: 0,
    inProgress: 0,
    completed: 0,
    cancelled: 0,
    percentComplete: 0,
  });
  private _loading = signal(false);
  private _error = signal<string | null>(null);
  private _showCompleted = signal(true);

  // Selectors
  currentSessionId = this._currentSessionId.asReadonly();
  todos = this._todos.asReadonly();
  stats = this._stats.asReadonly();
  loading = this._loading.asReadonly();
  error = this._error.asReadonly();
  showCompleted = this._showCompleted.asReadonly();

  /** Current in-progress TODO (if any) */
  currentTodo = computed(() =>
    this._todos().find((t) => t.status === 'in_progress')
  );

  /** Pending TODOs */
  pendingTodos = computed(() =>
    this._todos().filter((t) => t.status === 'pending')
  );

  /** Completed TODOs */
  completedTodos = computed(() =>
    this._todos().filter((t) => t.status === 'completed')
  );

  /** Visible TODOs based on filter */
  visibleTodos = computed(() => {
    const all = this._todos();
    if (this._showCompleted()) return all;
    return all.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
  });

  /** Whether there are any TODOs */
  hasTodos = computed(() => this._todos().length > 0);

  /** Whether progress is being made (has in-progress item) */
  isWorking = computed(() => this.currentTodo() !== undefined);

  constructor() {
    // Subscribe to TODO list changes from main process
    this.unsubscribe = this.ipcService.onTodoListChanged((data: { sessionId: string; list: TodoList }) => {
      if (data.sessionId === this._currentSessionId()) {
        this.updateFromList(data.list);
      }
    });
  }

  ngOnDestroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Set the current session and load its TODOs
   */
  async setSession(sessionId: string | null): Promise<void> {
    if (sessionId === this._currentSessionId()) return;

    this._currentSessionId.set(sessionId);

    if (!sessionId) {
      this.clearState();
      return;
    }

    await this.loadTodos(sessionId);
  }

  /**
   * Load TODOs for a session
   */
  async loadTodos(sessionId: string): Promise<void> {
    this._loading.set(true);
    this._error.set(null);

    try {
      const response = await this.ipcService.todoGetList(sessionId);
      if (response.success && 'data' in response && response.data) {
        const list = response.data as TodoList;
        this.updateFromList(list);
      } else {
        const errorMsg = response.error?.message || 'Failed to load TODOs';
        this._error.set(errorMsg);
      }
    } catch (err) {
      this._error.set((err as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Create a new TODO
   */
  async createTodo(
    content: string,
    options?: {
      activeForm?: string;
      priority?: TodoPriority;
      parentId?: string;
    }
  ): Promise<{ success: boolean; item?: TodoItem; error?: string }> {
    const sessionId = this._currentSessionId();
    if (!sessionId) {
      return { success: false, error: 'No active session' };
    }

    try {
      const response = await this.ipcService.todoCreate({
        sessionId,
        content,
        ...options,
      });

      if (response.success && 'data' in response && response.data) {
        return { success: true, item: response.data as TodoItem };
      }
      return { success: false, error: response.error?.message };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Update a TODO
   */
  async updateTodo(
    todoId: string,
    updates: {
      content?: string;
      activeForm?: string;
      status?: TodoStatus;
      priority?: TodoPriority;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const sessionId = this._currentSessionId();
    if (!sessionId) {
      return { success: false, error: 'No active session' };
    }

    try {
      const response = await this.ipcService.todoUpdate({
        sessionId,
        todoId,
        ...updates,
      });

      if (response.success) {
        return { success: true };
      }
      return { success: false, error: response.error?.message };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Delete a TODO
   */
  async deleteTodo(todoId: string): Promise<{ success: boolean; error?: string }> {
    const sessionId = this._currentSessionId();
    if (!sessionId) {
      return { success: false, error: 'No active session' };
    }

    try {
      const response = await this.ipcService.todoDelete(sessionId, todoId);
      if (response.success) {
        return { success: true };
      }
      return { success: false, error: response.error?.message };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Mark a TODO as in progress
   */
  async startTodo(todoId: string): Promise<{ success: boolean; error?: string }> {
    return this.updateTodo(todoId, { status: 'in_progress' });
  }

  /**
   * Mark a TODO as completed
   */
  async completeTodo(todoId: string): Promise<{ success: boolean; error?: string }> {
    return this.updateTodo(todoId, { status: 'completed' });
  }

  /**
   * Clear all TODOs for current session
   */
  async clearTodos(): Promise<{ success: boolean; error?: string }> {
    const sessionId = this._currentSessionId();
    if (!sessionId) {
      return { success: false, error: 'No active session' };
    }

    try {
      const response = await this.ipcService.todoClear(sessionId);
      if (response.success) {
        this.clearState();
        return { success: true };
      }
      return { success: false, error: response.error?.message };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Toggle showing completed TODOs
   */
  toggleShowCompleted(): void {
    this._showCompleted.update((v) => !v);
  }

  /**
   * Update state from a TODO list
   */
  private updateFromList(list: TodoList): void {
    this._todos.set(list.items);
    this._stats.set(list.stats);
  }

  /**
   * Clear local state
   */
  private clearState(): void {
    this._todos.set([]);
    this._stats.set({
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      cancelled: 0,
      percentComplete: 0,
    });
    this._error.set(null);
  }
}
