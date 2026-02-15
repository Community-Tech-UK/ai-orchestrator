/**
 * Orchestration Protocol - Defines the communication protocol for Claude to control the orchestrator
 */

import { CLAUDE_MODELS } from '../../shared/types/provider.types';
import type {
  ArtifactType,
  ArtifactSeverity,
  ReportResultCommand,
  GetChildSummaryCommand,
  GetChildArtifactsCommand,
  GetChildSectionCommand,
} from '../../shared/types/child-result.types';
import type { ConsensusStrategy } from '../../shared/types/consensus.types';

export const ORCHESTRATION_MARKER_START = ':::ORCHESTRATOR_COMMAND:::';
export const ORCHESTRATION_MARKER_END = ':::END_COMMAND:::';

export type OrchestratorAction =
  | 'spawn_child'
  | 'message_child'
  | 'get_children'
  | 'terminate_child'
  | 'get_child_output'
  | 'call_tool'
  | 'report_task_complete'
  | 'report_progress'
  | 'report_error'
  | 'get_task_status'
  | 'request_user_action'
  // Structured result commands
  | 'report_result'
  | 'get_child_summary'
  | 'get_child_artifacts'
  | 'get_child_section'
  // Multi-model consensus
  | 'consensus_query';

export interface SpawnChildCommand {
  action: 'spawn_child';
  task: string;
  name?: string;
  workingDirectory?: string;
  agentId?: string;
  model?: string;
  /** CLI provider to use: 'claude', 'codex', 'gemini', or 'auto' (default) */
  provider?: 'claude' | 'codex' | 'gemini' | 'auto';
  /** Explicitly enable YOLO for this child (requires user confirmation upstream) */
  yoloMode?: boolean;
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

export interface CallToolCommand {
  action: 'call_tool';
  toolId: string;
  args?: unknown;
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

/**
 * Request types that can be sent to the user
 */
export type UserActionRequestType =
  | 'switch_mode'      // Request to switch from plan to build mode (or vice versa)
  | 'approve_action'   // Request approval for a specific action
  | 'confirm'          // Generic confirmation request
  | 'select_option';   // Request user to select from options

/**
 * Request user action command - asks the user to approve/confirm something
 */
export interface RequestUserActionCommand {
  action: 'request_user_action';
  /** Type of request */
  requestType: UserActionRequestType;
  /** Title shown to user */
  title: string;
  /** Detailed message explaining what's being requested */
  message: string;
  /** For switch_mode: the target mode */
  targetMode?: 'build' | 'plan' | 'review';
  /** For select_option: available options */
  options?: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  /** Additional context/metadata */
  context?: Record<string, unknown>;
}

/**
 * Consensus query - ask multiple AI providers the same question and get synthesized consensus
 */
export interface ConsensusQueryCommand {
  action: 'consensus_query';
  /** The question or prompt to send to all providers */
  question: string;
  /** Context to include with the question */
  context?: string;
  /** Which providers to query (default: all available) */
  providers?: ('claude' | 'codex' | 'gemini' | 'copilot')[];
  /** Consensus strategy: 'majority' (default), 'weighted', or 'all' (no synthesis, raw responses) */
  strategy?: ConsensusStrategy;
  /** Timeout per provider in seconds (default: 60) */
  timeout?: number;
}

export type OrchestratorCommand =
  | SpawnChildCommand
  | MessageChildCommand
  | GetChildrenCommand
  | TerminateChildCommand
  | GetChildOutputCommand
  | CallToolCommand
  | ReportTaskCompleteCommand
  | ReportProgressCommand
  | ReportErrorCommand
  | GetTaskStatusCommand
  | RequestUserActionCommand
  // Structured result commands
  | ReportResultCommand
  | GetChildSummaryCommand
  | GetChildArtifactsCommand
  | GetChildSectionCommand
  // Multi-model consensus
  | ConsensusQueryCommand;

/**
 * Generate the system prompt that explains orchestration capabilities to Claude
 */
export function generateOrchestrationPrompt(instanceId: string, currentModel?: string): string {
  const modelIdentity = currentModel
    ? `You are currently running as **${currentModel}**.\n\n`
    : '';
  return `## 🎭 You Are an Orchestrator

${modelIdentity}You are a **parent instance** in AI Orchestrator. You can spawn and manage child AI instances for parallel work.

### When to Spawn Children
- **Truly parallel work**: Multiple independent tasks that can run simultaneously (e.g., analyzing 3 unrelated modules at once)
- **Specialized focus**: When a subtask needs completely different expertise (e.g., security audit while you do architecture review)

**Do NOT spawn children for:**
- Sequential analysis (tracing dependencies, following call chains, understanding data flow)
- Single-file or few-file tasks — read the files yourself
- Tasks where you need to synthesize information across steps (children can't see each other's work)
- Simple file reading — you can read files directly, it's cheaper than spawning a child

### Managing Children
- Children automatically receive your recent conversation context (last 10 messages)
- For additional context, include it in the task description
- Check progress with \`get_child_output\` (returns last 100 messages by default)
- **Always terminate children when done**

### Context Management
Your context window is finite. To work efficiently:
- **Read files directly** for most tasks — spawning children for file reads wastes tokens.
- **Only delegate** when you have genuinely independent parallel subtasks.
- **Use structured results**: Prefer \`get_child_summary\` over \`get_child_output\`.
- **Summarize, don't copy**: Have children summarize findings rather than returning full contents.
- If the system warns about context usage, consider summarizing your findings so far.
- If context overflows, the system will compact and retry — follow the guidance provided.

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
| spawn_child | task, name?, agentId?, model?, provider? |
| message_child | childId, message |
| get_children | (none) |
| terminate_child | childId |
| request_user_action | requestType, title, message, targetMode?, options? |
| call_tool | toolId, args? |

### Retrieving Child Results (Context-Safe)

Children report structured results that are stored externally. Use these commands to retrieve them without context overflow:

| Command | Parameters | Returns |
|---------|------------|---------|
| get_child_summary | childId | Summary + artifact count (~300 tokens) |
| get_child_artifacts | childId, types?, severity?, limit? | Structured findings |
| get_child_section | childId, section | "conclusions", "decisions", "artifacts", or "full" |
| get_child_output | childId, lastN? | Raw output (⚠️ can be large!) |

**Recommended workflow:**
1. Wait for child to complete (reports automatically)
2. Use \`get_child_summary\` first to see what they found
3. Use \`get_child_artifacts\` if you need specific findings
4. Only use \`get_child_output\` or \`get_child_section\` with "full" if you need the complete transcript

### Requesting User Actions

When you need user approval or want to switch modes, use \`request_user_action\`:

**Switch to Build Mode (from Plan mode):**
${ORCHESTRATION_MARKER_START}
{"action": "request_user_action", "requestType": "switch_mode", "targetMode": "build", "title": "Ready to Implement", "message": "Planning complete. Switch to build mode to begin implementation?"}
${ORCHESTRATION_MARKER_END}

**Request Approval:**
${ORCHESTRATION_MARKER_START}
{"action": "request_user_action", "requestType": "approve_action", "title": "Confirm Action", "message": "Description of what you want to do"}
${ORCHESTRATION_MARKER_END}

**Model options:** \`${CLAUDE_MODELS.HAIKU}\`, \`${CLAUDE_MODELS.SONNET}\`, \`${CLAUDE_MODELS.OPUS}\`
(Usually leave unspecified for automatic routing)

**Provider options:** \`claude\`, \`codex\`, \`gemini\`, \`copilot\`, \`auto\` (default: uses app settings)

### Multi-Model Consensus

When you need high-confidence answers, edge case analysis, or want to validate your reasoning, use \`consensus_query\` to ask multiple AI providers the same question and get a synthesized consensus:

${ORCHESTRATION_MARKER_START}
{"action": "consensus_query", "question": "What are the security implications of this approach?", "context": "Optional additional context for the question"}
${ORCHESTRATION_MARKER_END}

**When to use consensus:**
- Architecture/design decisions where multiple perspectives help
- Security reviews and edge case identification
- Validating your analysis when confidence is low
- Getting diverse perspectives on trade-offs

**When NOT to use consensus:**
- Simple factual lookups or file reads
- Tasks where speed matters more than thoroughness
- When you're already confident in the answer

**Options:**
- \`providers\`: Array of \`"claude"\`, \`"codex"\`, \`"gemini"\`, \`"copilot"\` (default: all available)
- \`strategy\`: \`"majority"\` (default), \`"weighted"\`, or \`"all"\` (raw responses, no synthesis)
- \`timeout\`: Seconds per provider (default: 60)

The response includes: synthesized consensus, agreement score, individual responses, disagreements, and edge cases.

Instance ID: ${instanceId}
`;
}

/**
 * Generate the prompt for a child instance
 */
export function generateChildPrompt(
  childId: string,
  parentId: string,
  task: string,
  taskId?: string,
  parentContext?: string
): string {
  const taskIdInfo = taskId ? ` (Task: ${taskId})` : '';

  // Build parent context section if provided
  const contextSection = parentContext
    ? `\n## Parent Context\nThe following is recent context from your parent instance to help you understand the broader situation:\n\n${parentContext}\n\n---\n`
    : '';

  return `## 👶 Child Instance${taskIdInfo}
${contextSection}
**Your Task:** ${task}

Focus only on this task. Be thorough but concise. You cannot spawn children.

### Reporting Results

**When done**, report your findings using structured artifacts to help your parent efficiently understand your work:

${ORCHESTRATION_MARKER_START}
{
  "action": "report_result",
  "summary": "Brief summary of what you found/accomplished (1-2 sentences)",
  "success": true,
  "artifacts": [
    {
      "type": "finding",
      "severity": "high",
      "title": "Brief title",
      "content": "Detailed description",
      "file": "path/to/file.ts",
      "lines": "45-52"
    },
    {
      "type": "recommendation",
      "content": "What should be done about this"
    },
    {
      "type": "code_snippet",
      "content": "relevant code here",
      "file": "path/to/file.ts",
      "lines": "10-20"
    }
  ],
  "conclusions": ["Key conclusion 1", "Key conclusion 2"],
  "keyDecisions": ["Decision made and why"]
}
${ORCHESTRATION_MARKER_END}

**Artifact types:** finding, recommendation, code_snippet, file_reference, decision, data, command, error, warning, success, metric
**Severity levels:** critical, high, medium, low, info

Your structured report is stored externally and your parent can retrieve specific parts without loading everything into context.

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
    case 'call_tool':
      return typeof (cmd as CallToolCommand).toolId === 'string';
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
    case 'request_user_action':
      return (
        typeof (cmd as RequestUserActionCommand).requestType === 'string' &&
        typeof (cmd as RequestUserActionCommand).title === 'string' &&
        typeof (cmd as RequestUserActionCommand).message === 'string'
      );
    // New structured result commands
    case 'report_result':
      return typeof (cmd as ReportResultCommand).summary === 'string';
    case 'get_child_summary':
      return typeof (cmd as GetChildSummaryCommand).childId === 'string';
    case 'get_child_artifacts':
      return typeof (cmd as GetChildArtifactsCommand).childId === 'string';
    case 'get_child_section':
      return (
        typeof (cmd as GetChildSectionCommand).childId === 'string' &&
        ['conclusions', 'decisions', 'artifacts', 'full'].includes(
          (cmd as GetChildSectionCommand).section
        )
      );
    case 'consensus_query':
      return typeof (cmd as ConsensusQueryCommand).question === 'string';
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
