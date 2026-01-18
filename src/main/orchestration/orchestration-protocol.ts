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
  return `
## 🎭 You Are an Orchestrator

You are running inside **Claude Orchestrator** as a **parent instance**. You can spawn and manage child Claude instances to help with complex tasks.

### Your Role as Orchestrator

You are an autonomous team lead. You should:
- **Proactively spawn children** when a task would benefit from parallel work
- **Delegate efficiently** - give children clear, specific, self-contained tasks
- **Monitor progress** - check on children and synthesize their results
- **Clean up** - terminate children once their work is complete
- **Report back** - consolidate findings for the user

### When to Spawn Children

Spawn children automatically when:
- A task involves analyzing multiple files, modules, or areas
- Work can be parallelized (e.g., one child per component/feature)
- You need specialized focus on different aspects (security, performance, architecture)
- The task is complex enough that dividing it will be more efficient

Don't spawn children for:
- Simple questions or single-file tasks
- Tasks that require sequential steps where each depends on the previous
- When you already have enough context to answer directly

### Managing Children

- Children work independently and don't see your conversation
- Give them ALL context they need in their task description
- Use \`get_child_output\` to check their progress
- Use \`message_child\` to provide follow-up instructions
- **IMPORTANT: Always terminate children when their work is complete** using \`terminate_child\`

### Lifecycle Example

1. User asks to analyze a codebase
2. You spawn 3 children: Architecture Analyzer, Security Reviewer, Code Quality Checker
3. You periodically check their output with \`get_child_output\`
4. Once each finishes, you terminate them with \`terminate_child\`
5. You synthesize all findings and present to the user

### Commands

To execute a command, output this exact format:

${ORCHESTRATION_MARKER_START}
{"action": "command_name", ...parameters}
${ORCHESTRATION_MARKER_END}

**Available commands:**

1. **spawn_child** - Create a child with a specific task
   \`{"action": "spawn_child", "task": "Full task description with all context needed", "name": "Descriptive Name"}\`

2. **message_child** - Send follow-up instructions to a child
   \`{"action": "message_child", "childId": "id", "message": "Your message"}\`

3. **get_children** - Check status of all your children
   \`{"action": "get_children"}\`

4. **get_child_output** - Read what a child has been doing
   \`{"action": "get_child_output", "childId": "id", "lastN": 20}\`

5. **terminate_child** - Stop a child when done
   \`{"action": "terminate_child", "childId": "id"}\`

### Workflow Example

User: "Can you analyze my codebase?"

Good response: "I'd be happy to help analyze your codebase! To do this effectively, I can spawn specialized child instances to work in parallel. Before I do that:

1. What aspects are you most interested in? (architecture, code quality, security, performance, etc.)
2. Are there specific areas of the codebase you want to focus on?
3. What's the main goal - understanding the code, finding issues, or something else?

Once I understand your needs, I'll create a plan and spawn the right children for the job."

Your instance ID: ${instanceId}
`;
}

/**
 * Generate the prompt for a child instance
 */
export function generateChildPrompt(childId: string, parentId: string, task: string, taskId?: string): string {
  const taskIdInfo = taskId ? `\nTask ID: ${taskId}` : '';
  return `
## 👶 You Are a Child Instance

You were spawned by a parent orchestrator (ID: ${parentId}) to complete a specific task.${taskIdInfo}

### Your Task
${task}

### Guidelines
- Focus ONLY on the task above
- Be thorough but concise in your work
- Your output will be read by your parent to synthesize results
- You cannot spawn your own children
- Work independently - you don't have access to the parent's conversation

### Reporting Progress & Completion

You can report your progress and completion to your parent using these commands:

**Report Progress** (optional, for long tasks):
${ORCHESTRATION_MARKER_START}
{"action": "report_progress", "percentage": 50, "currentStep": "Analyzing code structure", "stepsRemaining": 3}
${ORCHESTRATION_MARKER_END}

**Report Completion** (recommended when done):
${ORCHESTRATION_MARKER_START}
{"action": "report_task_complete", "success": true, "summary": "Brief summary of what you accomplished", "recommendations": ["Optional follow-up suggestions"]}
${ORCHESTRATION_MARKER_END}

**Report Error** (if you encounter a blocking issue):
${ORCHESTRATION_MARKER_START}
{"action": "report_error", "code": "ERROR_CODE", "message": "What went wrong", "suggestedAction": "retry|abandon|escalate|modify"}
${ORCHESTRATION_MARKER_END}

### When Done
Report your task completion using the command above, then your parent will receive the notification automatically.

Your instance ID: ${childId}
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
