import type { OutputMessage } from '../../shared/types/instance.types';
import type { TodoStatus } from '../../shared/types/todo.types';

export interface ParsedTodoToolItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

const TODO_WRITE_TOOL_NAMES = new Set(['TodoWrite', 'todo_write', 'todo.write']);
const UPDATE_PLAN_TOOL_NAMES = new Set(['update_plan', 'UpdatePlan', 'updatePlan']);

export function extractTodoToolItems(message: OutputMessage): ParsedTodoToolItem[] | null {
  if (message.type !== 'tool_use' && message.type !== 'tool_result') {
    return null;
  }

  const metadata = asRecord(message.metadata);
  if (!metadata) {
    return null;
  }

  const toolName = readString(metadata, ['name', 'toolName', 'tool_name']);
  if (!toolName) {
    return null;
  }

  const input = readInputRecord(metadata);
  if (!input) {
    return null;
  }

  if (TODO_WRITE_TOOL_NAMES.has(toolName)) {
    return parseTodoWriteInput(input);
  }

  if (UPDATE_PLAN_TOOL_NAMES.has(toolName)) {
    return parseUpdatePlanInput(input);
  }

  return null;
}

function parseTodoWriteInput(input: Record<string, unknown>): ParsedTodoToolItem[] | null {
  const todos = input['todos'];
  if (!Array.isArray(todos)) {
    return null;
  }

  return todos.flatMap((item) => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }

    const content = readString(record, ['content', 'task', 'step']);
    if (!content) {
      return [];
    }

    const activeForm = readString(record, ['activeForm', 'active_form']);
    return [{
      content,
      status: normalizeTodoStatus(readString(record, ['status'])),
      ...(activeForm ? { activeForm } : {}),
    }];
  });
}

function parseUpdatePlanInput(input: Record<string, unknown>): ParsedTodoToolItem[] | null {
  const plan = input['plan'];
  if (!Array.isArray(plan)) {
    return null;
  }

  return plan.flatMap((item) => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }

    const content = readString(record, ['step', 'content', 'task']);
    if (!content) {
      return [];
    }

    return [{
      content,
      status: normalizeTodoStatus(readString(record, ['status'])),
    }];
  });
}

function readInputRecord(metadata: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ['input', 'arguments', 'args']) {
    const value = metadata[key];
    const record = asRecord(value);
    if (record) {
      return record;
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        const parsedRecord = asRecord(parsed);
        if (parsedRecord) {
          return parsedRecord;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalizeTodoStatus(status: string | null): TodoStatus {
  switch ((status ?? '').trim().toLowerCase().replace(/-/g, '_')) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'in_progress':
    case 'inprogress':
    case 'active':
    case 'running':
      return 'in_progress';
    case 'cancelled':
    case 'canceled':
    case 'skipped':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
