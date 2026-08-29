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

    const taskId = extractId(
      content,
      /Command running in background with ID:\s*([A-Za-z0-9_-]+)/i,
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

export function parseClaudeToolProgress(message: Record<string, unknown>): CliAsyncWorkEvent | null {
  if (message['type'] !== 'tool_progress') {
    return null;
  }

  const workId = message['parent_tool_use_id'] ?? message['tool_use_id'];
  const kind = kindForToolName(message['tool_name']);
  if (typeof workId !== 'string' || !kind) {
    return null;
  }

  return {
    phase: 'progress',
    workId,
    kind,
  };
}
