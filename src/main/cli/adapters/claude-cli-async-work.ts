import { asUnknownRecord } from './claude-cli-adapter.types';

export type CliAsyncWorkKind = 'background-shell' | 'subagent';
export type CliAsyncWorkTerminalStatus = 'completed' | 'failed' | 'stopped';

export type CliAsyncWorkEvent =
  | {
      phase: 'started';
      workId: string;
      replacesWorkId?: string;
      kind: CliAsyncWorkKind;
    }
  | {
      phase: 'progress';
      workId: string;
      replacesWorkId?: string;
      kind: CliAsyncWorkKind;
    }
  | {
      phase: 'terminal';
      workId: string;
      replacesWorkId?: string;
      kind: CliAsyncWorkKind;
      status: CliAsyncWorkTerminalStatus;
      continueOnCompletion?: boolean;
    }
  | {
      /** The provider's complete list of live background work; replaces the tracked set. */
      phase: 'snapshot';
      work: { workId: string; kind: CliAsyncWorkKind }[];
    }
  | {
      /** The provider started a turn by itself to handle a finished background task. */
      phase: 'provider-resumed';
    };

export function parseClaudeAsyncWorkToolUse(
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown>,
): CliAsyncWorkEvent | null {
  if (toolName !== 'Bash' || input['run_in_background'] !== true) {
    return null;
  }

  return {
    phase: 'started',
    workId: toolUseId,
    kind: 'background-shell',
  };
}

function extractId(content: string, pattern: RegExp): string | null {
  return content.match(pattern)?.[1] ?? null;
}

function isBackgroundBashInput(input: Record<string, unknown> | undefined): boolean {
  return input?.['run_in_background'] === true;
}

function kindForToolName(toolName: unknown): CliAsyncWorkKind | null {
  if (toolName === 'Bash') {
    return 'background-shell';
  }
  if (toolName === 'Agent') {
    return 'subagent';
  }
  return null;
}

export function parseClaudeAsyncWorkToolResult(
  toolUseId: string,
  toolName: string,
  content: string,
  isError: boolean,
  toolInput?: Record<string, unknown>,
): CliAsyncWorkEvent | null {
  if (toolName === 'Bash') {
    if (isError) {
      if (!isBackgroundBashInput(toolInput)) {
        return null;
      }
      return {
        phase: 'terminal',
        workId: toolUseId,
        kind: 'background-shell',
        status: 'failed',
        continueOnCompletion: false,
      };
    }

    // Explicit `run_in_background`, or a foreground command Claude moved to
    // the background when it hit its timeout.
    const taskId = extractId(
      content,
      /Command running in background with ID:\s*([A-Za-z0-9_-]+)/i,
    ) ?? extractId(
      content,
      /was moved to the background \(ID:\s*([A-Za-z0-9_-]+)\)/i,
    );
    if (!taskId) {
      return null;
    }
    return {
      phase: 'started',
      workId: taskId,
      replacesWorkId: toolUseId,
      kind: 'background-shell',
    };
  }

  if (toolName === 'Agent' && !isError) {
    const agentId = extractId(content, /\bagentId:\s*([A-Za-z0-9_-]+)/i);
    if (!agentId) {
      return null;
    }
    return {
      phase: 'started',
      workId: agentId,
      replacesWorkId: toolUseId,
      kind: 'subagent',
    };
  }

  return null;
}

function extractTaskNotificationTag(content: string, tagName: string): string | null {
  const match = content.match(new RegExp(`<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`, 'i'));
  return match?.[1]?.trim() || null;
}

export function parseClaudeTaskNotification(content: string): CliAsyncWorkEvent | null {
  if (!content.includes('<task-notification>')) {
    return null;
  }

  const workId = extractTaskNotificationTag(content, 'task-id');
  const status = extractTaskNotificationTag(content, 'status');
  if (
    !workId
    || (status !== 'completed' && status !== 'failed' && status !== 'stopped')
  ) {
    return null;
  }

  const replacesWorkId = extractTaskNotificationTag(content, 'tool-use-id') ?? undefined;
  return {
    phase: 'terminal',
    workId,
    ...(replacesWorkId ? { replacesWorkId } : {}),
    kind: replacesWorkId ? 'background-shell' : 'subagent',
    status,
  };
}

export function parseClaudeToolProgress(message: unknown): CliAsyncWorkEvent | null {
  const record = asUnknownRecord(message);
  if (!record || record['type'] !== 'tool_progress') {
    return null;
  }

  const workId = record['parent_tool_use_id'] ?? record['tool_use_id'];
  const kind = kindForToolName(record['tool_name']);
  if (typeof workId !== 'string' || !kind) {
    return null;
  }

  return {
    phase: 'progress',
    workId,
    kind,
  };
}

function kindForTaskType(taskType: unknown): CliAsyncWorkKind | null {
  if (taskType === 'local_bash') {
    return 'background-shell';
  }
  if (taskType === 'local_agent') {
    return 'subagent';
  }
  return null;
}

interface TrackedClaudeTask {
  kind: CliAsyncWorkKind;
  toolUseId?: string;
  ownedBySubagent: boolean;
  backgrounded: boolean;
}

/**
 * Current Claude CLI (stream-json) reports task lifecycle as `system` messages:
 * `task_started` (`is_backgrounded`, `owned_by_subagent`), `task_updated`
 * (`patch.is_backgrounded` when a timeout moves a command to the background),
 * `background_tasks_changed` (the full live list), `task_progress`, and
 * `task_notification`. After a notification that arrives between turns the CLI
 * starts a turn by itself, which begins with a fresh `init`.
 *
 * Stateful because a notification does not say whether its task was ever
 * backgrounded or belongs to a subagent; only `task_started` does. One tracker
 * per CLI process.
 */
export class ClaudeBackgroundTaskTracker {
  private readonly tasks = new Map<string, TrackedClaudeTask>();
  /** Last reported live list, so a later-identified subagent task can be withdrawn from it. */
  private lastSnapshot: { workId: string; kind: CliAsyncWorkKind }[] = [];
  private notifiedSinceLastInit = false;

  observe(message: unknown): CliAsyncWorkEvent[] {
    const record = asUnknownRecord(message);
    if (!record || record['type'] !== 'system') {
      return [];
    }

    switch (record['subtype']) {
      case 'task_started':
        return this.onStarted(record);
      case 'task_updated':
        return this.onUpdated(record);
      case 'background_tasks_changed':
        return this.onSnapshot(record);
      case 'task_progress':
        return this.onProgress(record);
      case 'task_notification':
        return this.onNotification(record);
      case 'init':
        return this.onInit();
      default:
        return [];
    }
  }

  reset(): void {
    this.tasks.clear();
    this.lastSnapshot = [];
    this.notifiedSinceLastInit = false;
  }

  private onStarted(record: Record<string, unknown>): CliAsyncWorkEvent[] {
    const taskId = record['task_id'];
    const kind = kindForTaskType(record['task_type']);
    if (typeof taskId !== 'string' || !taskId || !kind) {
      return [];
    }
    const toolUseId = typeof record['tool_use_id'] === 'string' ? record['tool_use_id'] : undefined;
    const task: TrackedClaudeTask = {
      kind,
      ...(toolUseId ? { toolUseId } : {}),
      ownedBySubagent: record['owned_by_subagent'] === true,
      backgrounded: false,
    };
    this.tasks.set(taskId, task);
    if (task.ownedBySubagent && this.lastSnapshot.some((item) => item.workId === taskId)) {
      // The list change for a new task can arrive before its task_started (seen
      // in live probes for top-level tasks), so a snapshot cannot yet know the
      // task belongs to a subagent. Defensive: subagent-owned background tasks
      // have not been observed in a snapshot.
      this.lastSnapshot = this.lastSnapshot.filter((item) => item.workId !== taskId);
      return [{ phase: 'snapshot', work: [...this.lastSnapshot] }];
    }
    return record['is_backgrounded'] === true ? this.markBackgrounded(taskId, task) : [];
  }

  private onUpdated(record: Record<string, unknown>): CliAsyncWorkEvent[] {
    const taskId = record['task_id'];
    const patch = asUnknownRecord(record['patch']);
    if (typeof taskId !== 'string' || patch?.['is_backgrounded'] !== true) {
      return [];
    }
    const task = this.tasks.get(taskId);
    return task ? this.markBackgrounded(taskId, task) : [];
  }

  private markBackgrounded(taskId: string, task: TrackedClaudeTask): CliAsyncWorkEvent[] {
    if (task.ownedBySubagent || task.backgrounded) {
      return [];
    }
    task.backgrounded = true;
    return [{
      phase: 'started',
      workId: taskId,
      ...(task.toolUseId ? { replacesWorkId: task.toolUseId } : {}),
      kind: task.kind,
    }];
  }

  private onSnapshot(record: Record<string, unknown>): CliAsyncWorkEvent[] {
    const tasks = record['tasks'];
    if (!Array.isArray(tasks)) {
      return [];
    }
    const work: { workId: string; kind: CliAsyncWorkKind }[] = [];
    for (const entry of tasks) {
      const item = asUnknownRecord(entry);
      const workId = item?.['task_id'];
      const kind = kindForTaskType(item?.['task_type']);
      if (typeof workId !== 'string' || !workId || !kind) continue;
      if (this.tasks.get(workId)?.ownedBySubagent) continue;
      work.push({ workId, kind });
    }
    this.lastSnapshot = work;
    return [{ phase: 'snapshot', work: [...work] }];
  }

  private onProgress(record: Record<string, unknown>): CliAsyncWorkEvent[] {
    const taskId = record['task_id'];
    const task = typeof taskId === 'string' ? this.tasks.get(taskId) : undefined;
    if (typeof taskId !== 'string' || !task?.backgrounded) {
      return [];
    }
    return [{ phase: 'progress', workId: taskId, kind: task.kind }];
  }

  private onNotification(record: Record<string, unknown>): CliAsyncWorkEvent[] {
    const taskId = record['task_id'];
    const status = record['status'];
    if (typeof taskId !== 'string') {
      return [];
    }
    const task = this.tasks.get(taskId);
    if (status !== 'completed' && status !== 'failed' && status !== 'stopped') {
      return [];
    }
    this.tasks.delete(taskId);
    if (!task?.backgrounded) {
      return [];
    }
    this.notifiedSinceLastInit = true;
    return [{
      phase: 'terminal',
      workId: taskId,
      ...(task.toolUseId ? { replacesWorkId: task.toolUseId } : {}),
      kind: task.kind,
      status,
    }];
  }

  /**
   * Also fires if an app-sent turn is the first `init` after a notification;
   * the continuation's requestCount check covers that case.
   */
  private onInit(): CliAsyncWorkEvent[] {
    if (!this.notifiedSinceLastInit) {
      return [];
    }
    this.notifiedSinceLastInit = false;
    return [{ phase: 'provider-resumed' }];
  }
}
