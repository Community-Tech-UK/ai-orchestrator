/**
 * Orchestration Protocol - Defines the communication protocol for Claude to control the orchestrator
 */

export const ORCHESTRATION_MARKER_START = ':::ORCHESTRATOR_COMMAND:::';
export const ORCHESTRATION_MARKER_END = ':::END_COMMAND:::';

export type OrchestratorAction =
  | 'spawn_child'
  | 'message_child'
  | 'get_children'
  | 'terminate_child'
  | 'get_child_output'
  | 'report_task_complete'
  | 'report_progress'
  | 'report_error'
  | 'get_task_status';

export interface SpawnChildCommand {
  action: 'spawn_child';
  task: string;
  name?: string;
  workingDirectory?: string;
  agentId?: string;
  model?: string;
}

export interface MessageChildCommand {
  action: 'message_child';
  childId: string;
  message: string;
}

export interface GetChildrenCommand {
  action: 'get_children';
}

export interface TerminateChildCommand {
  action: 'terminate_child';
  childId: string;
}

export interface GetChildOutputCommand {
  action: 'get_child_output';
  childId: string;
  lastN?: number;
}

export interface ReportTaskCompleteCommand {
  action: 'report_task_complete';
  taskId?: string;
  success: boolean;
  summary: string;
  data?: Record<string, unknown>;
  artifacts?: Array<{
    type: 'file' | 'data' | 'url';
    path?: string;
    name: string;
    description?: string;
  }>;
  recommendations?: string[];
}

export interface ReportProgressCommand {
  action: 'report_progress';
  taskId?: string;
  percentage: number;
  currentStep: string;
  stepsRemaining?: number;
}

export interface ReportErrorCommand {
  action: 'report_error';
  taskId?: string;
  code: string;
  message: string;
  context?: string;
  suggestedAction?: 'retry' | 'abandon' | 'escalate' | 'modify';
}

export interface GetTaskStatusCommand {
  action: 'get_task_status';
  taskId?: string;
}

export type OrchestratorCommand =
  | SpawnChildCommand
  | MessageChildCommand
  | GetChildrenCommand
  | TerminateChildCommand
  | GetChildOutputCommand
  | ReportTaskCompleteCommand
  | ReportProgressCommand
  | ReportErrorCommand
  | GetTaskStatusCommand;

/**
 * Generate the system prompt that explains orchestration capabilities to Claude
 */
export function generateOrchestrationPrompt(instanceId: string): string {
  return `## 🎭 You Are an Orchestrator

You are a **parent instance** in Claude Orchestrator. You can spawn and manage child Claude instances for parallel work.

### When to Spawn Children
- Multiple files/modules to analyze in parallel
- Specialized focus needed (security, performance, architecture)
- Complex tasks benefiting from division of labor

Don't spawn for: simple questions, single-file tasks, or sequential dependencies.

### Managing Children
- Give children ALL context they need (they can't see your conversation)
- Check progress with \`get_child_output\`
- **Always terminate children when done**

### Intelligent Model Routing
Children are automatically routed to the optimal model based on task complexity:
- **Simple tasks** (file lookups, status checks) → Haiku (fast, cost-effective)
- **Moderate tasks** (standard development) → Sonnet (balanced)
- **Complex tasks** (architecture, security analysis) → Opus (most capable)

You can override this by specifying a \`model\` parameter, but automatic routing typically saves 40-85% on costs.

### Commands

Format:
${ORCHESTRATION_MARKER_START}
{"action": "command_name", ...params}
${ORCHESTRATION_MARKER_END}

| Command | Parameters |
|---------|------------|
| spawn_child | task, name?, agentId?, model? |
| message_child | childId, message |
| get_children | (none) |
| get_child_output | childId, lastN? |
| terminate_child | childId |

**Model options:** \`claude-3-5-haiku-20241022\`, \`claude-sonnet-4-20250514\`, \`claude-opus-4-20250514\`
(Usually leave unspecified for automatic routing)

Instance ID: ${instanceId}
`;
}

/**
 * Generate the prompt for a child instance
 */
export function generateChildPrompt(childId: string, parentId: string, task: string, taskId?: string): string {
  const taskIdInfo = taskId ? ` (Task: ${taskId})` : '';
  return `## 👶 Child Instance${taskIdInfo}

**Your Task:** ${task}

Focus only on this task. Be thorough but concise. You cannot spawn children.

**When done**, report completion:
${ORCHESTRATION_MARKER_START}
{"action": "report_task_complete", "success": true, "summary": "What you accomplished"}
${ORCHESTRATION_MARKER_END}

Instance: ${childId} | Parent: ${parentId}
`;
}

/**
 * Parse orchestrator commands from text output
 */
export function parseOrchestratorCommands(text: string): OrchestratorCommand[] {
  const commands: OrchestratorCommand[] = [];
  const regex = new RegExp(
    `${escapeRegex(ORCHESTRATION_MARKER_START)}\\s*([\\s\\S]*?)\\s*${escapeRegex(ORCHESTRATION_MARKER_END)}`,
    'g'
  );

  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const jsonStr = match[1].trim();
      const command = JSON.parse(jsonStr) as OrchestratorCommand;

      // Validate the command has required fields
      if (isValidCommand(command)) {
        commands.push(command);
      }
    } catch (e) {
      console.warn('Failed to parse orchestrator command:', e);
    }
  }

  return commands;
}

/**
 * Check if a command is valid
 */
function isValidCommand(cmd: unknown): cmd is OrchestratorCommand {
  if (!cmd || typeof cmd !== 'object') return false;

  const action = (cmd as { action?: string }).action;

  switch (action) {
    case 'spawn_child':
      return typeof (cmd as SpawnChildCommand).task === 'string';
    case 'message_child':
      return (
        typeof (cmd as MessageChildCommand).childId === 'string' &&
        typeof (cmd as MessageChildCommand).message === 'string'
      );
    case 'get_children':
      return true;
    case 'terminate_child':
      return typeof (cmd as TerminateChildCommand).childId === 'string';
    case 'get_child_output':
      return typeof (cmd as GetChildOutputCommand).childId === 'string';
    case 'report_task_complete':
      return (
        typeof (cmd as ReportTaskCompleteCommand).success === 'boolean' &&
        typeof (cmd as ReportTaskCompleteCommand).summary === 'string'
      );
    case 'report_progress':
      return (
        typeof (cmd as ReportProgressCommand).percentage === 'number' &&
        typeof (cmd as ReportProgressCommand).currentStep === 'string'
      );
    case 'report_error':
      return (
        typeof (cmd as ReportErrorCommand).code === 'string' &&
        typeof (cmd as ReportErrorCommand).message === 'string'
      );
    case 'get_task_status':
      return true;
    default:
      return false;
  }
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format a response to send back to Claude about command execution
 */
export function formatCommandResponse(
  action: OrchestratorAction,
  success: boolean,
  data: unknown
): string {
  return `
[Orchestrator Response]
Action: ${action}
Status: ${success ? 'SUCCESS' : 'FAILED'}
${JSON.stringify(data, null, 2)}
[/Orchestrator Response]
`;
}
