/**
 * TODO Types - Session-scoped task management
 *
 * Enables tracking of tasks and progress within complex AI sessions.
 * Reference: OpenCode /packages/opencode/src/tool/todo.ts
 */

/**
 * Status of a TODO item
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/**
 * Priority level for a TODO item
 */
export type TodoPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * A single TODO item
 */
export interface TodoItem {
  id: string;
  // The task description
  content: string;
  // Present continuous form for display (e.g., "Implementing feature")
  activeForm?: string;
  // Current status
  status: TodoStatus;
  // Priority level
  priority?: TodoPriority;
  // Parent TODO ID for nested tasks
  parentId?: string;
  // Session ID this TODO belongs to
  sessionId: string;
  // When the TODO was created
  createdAt: number;
  // When the TODO was last updated
  updatedAt: number;
  // When the TODO was completed (if applicable)
  completedAt?: number;
  // Optional metadata
  metadata?: Record<string, unknown>;
}

/**
 * Create TODO item request
 */
export interface CreateTodoRequest {
  content: string;
  activeForm?: string;
  priority?: TodoPriority;
  parentId?: string;
  status?: TodoStatus;
}

/**
 * Update TODO item request
 */
export interface UpdateTodoRequest {
  id: string;
  content?: string;
  activeForm?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
}

/**
 * TODO list for a session
 */
export interface TodoList {
  sessionId: string;
  items: TodoItem[];
  // Summary stats
  stats: TodoStats;
}

/**
 * Statistics for a TODO list
 */
export interface TodoStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  percentComplete: number;
}

/**
 * Calculate stats from a list of TODO items
 */
export function calculateTodoStats(items: TodoItem[]): TodoStats {
  const total = items.length;
  const completed = items.filter((i) => i.status === 'completed').length;
  return {
    total,
    pending: items.filter((i) => i.status === 'pending').length,
    inProgress: items.filter((i) => i.status === 'in_progress').length,
    completed,
    cancelled: items.filter((i) => i.status === 'cancelled').length,
    percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

/**
 * Generate a unique TODO ID
 */
export function generateTodoId(): string {
  return `todo_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a new TODO item
 */
export function createTodoItem(
  sessionId: string,
  request: CreateTodoRequest
): TodoItem {
  const now = Date.now();
  return {
    id: generateTodoId(),
    content: request.content,
    activeForm: request.activeForm,
    status: request.status || 'pending',
    priority: request.priority || 'medium',
    parentId: request.parentId,
    sessionId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Sort TODOs by status and priority
 */
export function sortTodos(items: TodoItem[]): TodoItem[] {
  const statusOrder: Record<TodoStatus, number> = {
    in_progress: 0,
    pending: 1,
    completed: 2,
    cancelled: 3,
  };

  const priorityOrder: Record<TodoPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return [...items].sort((a, b) => {
    // First sort by status
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;

    // Then by priority
    const priorityA = a.priority || 'medium';
    const priorityB = b.priority || 'medium';
    const priorityDiff = priorityOrder[priorityA] - priorityOrder[priorityB];
    if (priorityDiff !== 0) return priorityDiff;

    // Finally by creation time (oldest first)
    return a.createdAt - b.createdAt;
  });
}

/**
 * Filter completed TODOs older than a threshold
 */
export function filterOldCompletedTodos(
  items: TodoItem[],
  maxAgeMs: number = 24 * 60 * 60 * 1000 // 24 hours default
): TodoItem[] {
  const cutoff = Date.now() - maxAgeMs;
  return items.filter((item) => {
    if (item.status === 'completed' && item.completedAt) {
      return item.completedAt > cutoff;
    }
    return true;
  });
}

/**
 * Get child TODOs for a parent
 */
export function getChildTodos(items: TodoItem[], parentId: string): TodoItem[] {
  return items.filter((item) => item.parentId === parentId);
}

/**
 * Get root TODOs (no parent)
 */
export function getRootTodos(items: TodoItem[]): TodoItem[] {
  return items.filter((item) => !item.parentId);
}

/**
 * Build a hierarchical TODO tree
 */
export interface TodoTreeNode {
  item: TodoItem;
  children: TodoTreeNode[];
}

export function buildTodoTree(items: TodoItem[]): TodoTreeNode[] {
  const itemMap = new Map<string, TodoTreeNode>();

  // Create nodes for all items
  for (const item of items) {
    itemMap.set(item.id, { item, children: [] });
  }

  // Build tree structure
  const roots: TodoTreeNode[] = [];
  for (const item of items) {
    const node = itemMap.get(item.id)!;
    if (item.parentId && itemMap.has(item.parentId)) {
      itemMap.get(item.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children
  const sortNodes = (nodes: TodoTreeNode[]): TodoTreeNode[] => {
    return sortTodos(nodes.map((n) => n.item)).map((item) => {
      const node = itemMap.get(item.id)!;
      node.children = sortNodes(node.children);
      return node;
    });
  };

  return sortNodes(roots);
}

/**
 * Format TODO for display
 */
export function formatTodoForDisplay(item: TodoItem): string {
  const statusIcon: Record<TodoStatus, string> = {
    pending: '○',
    in_progress: '◐',
    completed: '●',
    cancelled: '✕',
  };

  const priorityIndicator: Record<TodoPriority, string> = {
    critical: '!!!',
    high: '!!',
    medium: '!',
    low: '',
  };

  const priority = item.priority || 'medium';
  const indicator = priorityIndicator[priority];

  return `${statusIcon[item.status]} ${indicator ? `[${indicator}] ` : ''}${item.content}`;
}

/**
 * Parse TODO content from AI tool calls
 * Handles the format Claude often uses in TodoWrite tool calls
 */
export interface ParsedTodoInput {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export function parseTodoInput(input: {
  content: string;
  status: string;
  activeForm?: string;
}): ParsedTodoInput {
  const validStatuses: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];
  const status = validStatuses.includes(input.status as TodoStatus)
    ? (input.status as TodoStatus)
    : 'pending';

  return {
    content: input.content,
    status,
    activeForm: input.activeForm || input.content,
  };
}
