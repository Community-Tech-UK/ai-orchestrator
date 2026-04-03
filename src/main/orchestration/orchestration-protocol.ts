/**
 * Orchestration Protocol - Defines the communication protocol for parent instances to control the orchestrator
 */

import { getLogger } from '../logging/logger';
import type {
  ReportResultCommand,
  GetChildSummaryCommand,
  GetChildArtifactsCommand,
  GetChildSectionCommand
} from '../../shared/types/child-result.types';
import type { ConsensusStrategy } from '../../shared/types/consensus.types';

const logger = getLogger('OrchestrationProtocol');

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
  /** CLI provider to use: 'claude', 'codex', 'gemini', 'copilot', or 'auto' (default) */
  provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'auto';
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
  artifacts?: {
    type: 'file' | 'data' | 'url';
    path?: string;
    name: string;
    description?: string;
  }[];
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
  | 'switch_mode' // Request to switch from plan to build mode (or vice versa)
  | 'approve_action' // Request approval for a specific action
  | 'confirm' // Generic confirmation request
  | 'select_option' // Request user to select from options
  | 'ask_questions'; // Ask user free-form questions (renders text inputs)

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
  options?: {
    id: string;
    label: string;
    description?: string;
  }[];
  /** For ask_questions: list of questions to ask the user (renders text inputs) */
  questions?: string[];
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
 * Generate the system prompt that explains orchestration capabilities to a parent instance
 */
export function generateOrchestrationPrompt(
  instanceId: string,
  currentModel?: string
): string {
  const modelIdentity = currentModel
    ? `You are currently running as **${currentModel}**.\n\n`
    : '';
  return `## You Are an Orchestrator

${modelIdentity}You are a **parent instance** in AI Orchestrator. You spawn and manage child AI instances for parallel work.

### Delegation Rules

**Spawn children ONLY when:**
- You have 2+ independent tasks that benefit from parallel execution
- A subtask needs specialized focus (e.g., security audit while you do architecture review)

**Do NOT spawn children for:**
- Sequential analysis, dependency tracing, or cross-step synthesis
- Single-file or few-file tasks — read files yourself
- Simple file reading — always cheaper to do directly

**On failure:** If a child errors or times out, retry once. If it fails again, do the work directly.

### Child Lifecycle

- Children receive your recent conversation context (last 10 messages). Include additional context in the task description if needed.
- Always terminate children when done.
- Prefer \`get_child_summary\` over \`get_child_output\` to avoid context overflow.

### Model Routing

Children are auto-routed by complexity. Specify \`model\` to override.
- **Simple** (lookups, status checks) → fast model tier
- **Moderate** (standard dev) → balanced model tier
- **Complex** (architecture, security) → powerful model tier

### Commands

All commands use this format:
${ORCHESTRATION_MARKER_START}
{"action": "command_name", ...params}
${ORCHESTRATION_MARKER_END}

| Command | Parameters |
|---------|------------|
| spawn_child | task, name?, agentId?, model?, provider? |
| message_child | childId, message |
| get_children | (none) |
| terminate_child | childId |
| call_tool | toolId, args? |

### Retrieving Child Results

Always prefer structured retrieval over raw output:

| Command | Parameters | Returns |
|---------|------------|---------|
| get_child_summary | childId | Summary + artifact count (~300 tokens) |
| get_child_artifacts | childId, types?, severity?, limit? | Structured findings |
| get_child_section | childId, section | "conclusions", "decisions", "artifacts", or "full" |
| get_child_output | childId, lastN? | Raw output (can be large — use as last resort) |

### User Interaction

Use \`request_user_action\` for approvals, mode switches, and questions:

| requestType | Use for | Extra params |
|-------------|---------|--------------|
| switch_mode | Switching plan/build/review mode | targetMode |
| approve_action | Confirming a specific action | — |
| ask_questions | Getting user input | questions[] |

Example (wrap with the command markers shown above):
\`\`\`json
{"action": "request_user_action", "requestType": "ask_questions", "title": "Clarifying Questions", "message": "I need some information:", "questions": ["What framework?", "What database?"]}
\`\`\`

### Multi-Model Consensus

Use \`consensus_query\` when you need high-confidence answers or want to validate reasoning across multiple AI providers. Do NOT use for simple lookups or when already confident.

Example (wrap with the command markers shown above):
\`\`\`json
{"action": "consensus_query", "question": "Your question here", "context": "Optional context"}
\`\`\`

Options: \`providers\` (default: all), \`strategy\` ("majority"|"weighted"|"all"), \`timeout\` (seconds, default: 60)

### Code Navigation

You have LSP (Language Server Protocol) tools available via MCP. **Use them when navigating code** — they are faster and more accurate than grep/glob for understanding code structure:

- \`mcp__lsp__lsp_goto_definition\` — Jump to where a symbol is defined
- \`mcp__lsp__lsp_find_references\` — Find all usages of a symbol
- \`mcp__lsp__lsp_hover\` — Get type info and documentation for a symbol
- \`mcp__lsp__lsp_document_symbols\` — List all symbols in a file (functions, classes, etc.)
- \`mcp__lsp__lsp_workspace_symbols\` — Search for symbols across the workspace
- \`mcp__lsp__lsp_find_implementations\` — Find implementations of an interface/abstract class
- \`mcp__lsp__lsp_type_definition\` — Jump to a symbol's type definition
- \`mcp__lsp__lsp_call_hierarchy\` — Trace callers/callees of a function
- \`mcp__lsp__lsp_diagnostics\` — Get compiler errors and warnings

Prefer LSP tools over grep when tracing imports, finding callers, understanding types, or navigating definitions. Use grep/glob for text pattern searches and file discovery.

---
**Model tiers:** \`fast\`, \`balanced\`, \`powerful\` (or set an explicit model ID)
**Providers:** \`claude\`, \`codex\`, \`gemini\`, \`copilot\`, \`auto\` (default)
**Instance ID:** ${instanceId}
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
      logger.warn('Failed to parse orchestrator command', { error: String(e) });
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
    case 'request_user_action': {
      const request = cmd as RequestUserActionCommand;
      const validRequestTypes: UserActionRequestType[] = [
        'switch_mode',
        'approve_action',
        'confirm',
        'select_option',
        'ask_questions',
      ];

      if (
        !validRequestTypes.includes(request.requestType) ||
        typeof request.title !== 'string' ||
        typeof request.message !== 'string'
      ) {
        return false;
      }

      if (request.requestType === 'switch_mode') {
        return request.targetMode === 'build' || request.targetMode === 'plan' || request.targetMode === 'review';
      }

      if (request.requestType === 'select_option') {
        return (
          Array.isArray(request.options) &&
          request.options.length > 0 &&
          request.options.every(
            (option) =>
              option &&
              typeof option.id === 'string' &&
              option.id.trim().length > 0 &&
              typeof option.label === 'string' &&
              option.label.trim().length > 0 &&
              (option.description === undefined || typeof option.description === 'string')
          )
        );
      }

      if (request.requestType === 'ask_questions') {
        return (
          Array.isArray(request.questions) &&
          request.questions.length > 0 &&
          request.questions.every(
            (question) => typeof question === 'string' && question.trim().length > 0
          )
        );
      }

      return true;
    }
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
 * Strip orchestration command blocks and response blocks from text.
 * Used to sanitize parent context before embedding in child prompts,
 * preventing children from echoing/re-executing parent commands.
 */
export function stripOrchestrationMarkers(text: string): string {
  let cleaned = text;

  // Strip orchestration command blocks
  cleaned = cleaned.replace(
    new RegExp(
      `${escapeRegex(ORCHESTRATION_MARKER_START)}\\s*[\\s\\S]*?\\s*${escapeRegex(ORCHESTRATION_MARKER_END)}`,
      'g'
    ),
    ''
  );

  // Strip orchestrator response blocks
  cleaned = cleaned.replace(
    /\[Orchestrator Response\][\s\S]*?\[\/Orchestrator Response\]/g,
    ''
  );

  // Clean up extra whitespace left behind
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

/**
 * Format a response to send back to a parent instance about command execution
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
