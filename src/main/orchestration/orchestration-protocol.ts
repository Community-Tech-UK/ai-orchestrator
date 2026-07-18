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
import {
  ORCHESTRATION_MARKER_START,
  ORCHESTRATION_MARKER_END,
} from './orchestration-protocol.types';
import type {
  OrchestratorAction,
  OrchestratorCommand,
  SpawnChildCommand,
  MessageChildCommand,
  GetChildrenCommand,
  TerminateChildCommand,
  GetChildOutputCommand,
  CallToolCommand,
  ReportTaskCompleteCommand,
  ReportProgressCommand,
  ReportErrorCommand,
  GetTaskStatusCommand,
  UserActionRequestType,
  RequestUserActionCommand,
  ConsensusQueryCommand,
  CreateAutomationCommand,
  OrchestratorNodeSummary,
} from './orchestration-protocol.types';

const logger = getLogger('OrchestrationProtocol');

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { ORCHESTRATION_MARKER_START, ORCHESTRATION_MARKER_END };

export type {
  OrchestratorAction,
  SpawnChildCommand,
  MessageChildCommand,
  GetChildrenCommand,
  TerminateChildCommand,
  GetChildOutputCommand,
  CallToolCommand,
  ReportTaskCompleteCommand,
  ReportProgressCommand,
  ReportErrorCommand,
  GetTaskStatusCommand,
  UserActionRequestType,
  RequestUserActionCommand,
  ConsensusQueryCommand,
  CreateAutomationCommand,
  OrchestratorCommand,
  OrchestratorNodeSummary,
};

export {
  generateOrchestrationPrompt,
  generateChildPrompt,
  detectsSchedulingIntent,
  SCHEDULING_INTENT_REMINDER,
} from './orchestration-protocol.prompts';

// ─── Command parsing ──────────────────────────────────────────────────────────

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
      const command = parseCommandJson(jsonStr) as OrchestratorCommand;

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
 * Parse the JSON payload of an orchestrator command, tolerating the single most
 * common defect in LLM-authored command JSON: RAW (unescaped) newlines, tabs, or
 * other control characters inside a string value — typically a multi-line
 * automation `prompt`. Strict `JSON.parse` rejects those with "Bad control
 * character in string literal" / "Unterminated string", which silently drops the
 * command (e.g. an automation the user asked for is never created).
 *
 * Strategy: try strict parsing first so well-formed JSON is never altered, then
 * retry once after escaping control characters that appear inside string
 * literals. Structural whitespace between tokens is left untouched.
 */
function parseCommandJson(jsonStr: string): unknown {
  try {
    return JSON.parse(jsonStr);
  } catch {
    // Retry with raw control characters inside string literals escaped.
    return JSON.parse(escapeControlCharsInsideStrings(jsonStr));
  }
}

/**
 * Escape control characters (code points < 0x20) that appear inside JSON string
 * literals, leaving everything outside string literals — including structural
 * whitespace and newlines between tokens — untouched. Backslash escapes are
 * respected so an already-escaped quote does not flip the in-string state.
 */
function escapeControlCharsInsideStrings(jsonStr: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }

    if (inString && ch.charCodeAt(0) < 0x20) {
      switch (ch) {
        case '\n':
          out += '\\n';
          break;
        case '\r':
          out += '\\r';
          break;
        case '\t':
          out += '\\t';
          break;
        case '\b':
          out += '\\b';
          break;
        case '\f':
          out += '\\f';
          break;
        default:
          out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
          break;
      }
      continue;
    }

    out += ch;
  }

  return out;
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
    case 'create_automation':
      return isValidCreateAutomationCommand(cmd as CreateAutomationCommand);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidCreateAutomationCommand(cmd: CreateAutomationCommand): boolean {
  if (!isRecord(cmd.automation)) {
    return false;
  }

  const automation = cmd.automation;
  if (typeof automation.name !== 'string' || automation.name.trim().length === 0) {
    return false;
  }

  if (!isRecord(automation.schedule)) {
    return false;
  }

  const schedule = automation.schedule;
  if (schedule['type'] === 'cron') {
    if (typeof schedule['expression'] !== 'string' || schedule['expression'].trim().length === 0) {
      return false;
    }
    if (typeof schedule['timezone'] !== 'string' || schedule['timezone'].trim().length === 0) {
      return false;
    }
  } else if (schedule['type'] === 'oneTime') {
    if (typeof schedule['runAt'] !== 'number' || !Number.isFinite(schedule['runAt'])) {
      return false;
    }
  } else {
    return false;
  }

  if (!isRecord(automation.action)) {
    return false;
  }

  return typeof automation.action['prompt'] === 'string' && automation.action['prompt'].trim().length > 0;
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
