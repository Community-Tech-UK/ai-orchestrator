import { isSessionNotFoundText } from '../resume-error-classifier';

export interface CodexDiagnostic {
  category: 'auth' | 'mcp' | 'models' | 'network' | 'process' | 'sandbox' | 'session' | 'startup' | 'tool-server' | 'unknown';
  fatal: boolean;
  /** The log line as Codex wrote it, minus its own timestamp. Provider text: Details only, never a sentence. */
  line: string;
  level: 'error' | 'info' | 'warning';
  /** Codex's own timestamp for the line, kept apart so repeats of one problem still match each other. */
  loggedAt?: string;
  /** The tool server a `tool-server` line names, when the line names one. */
  toolServer?: string;
  /** True when already surfaced to the UI during stderr streaming; close-time emit skips these. */
  streamed?: boolean;
}

const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
/** `2026-10-18T00:51:03.042357Z ERROR codex_core::tools::router: …` */
const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+/;

/** Every line Codex logs starts with its own clock reading, so two copies of one problem never compare equal. */
export function stripCodexLogTimestamp(line: string): { line: string; loggedAt?: string } {
  const plain = line.replace(ANSI_COLOUR, '').trim();
  const match = LOG_TIMESTAMP.exec(plain);
  return match ? { line: plain.slice(match[0].length).trim(), loggedAt: match[1] } : { line: plain };
}

const SERVER_NAME = '[`\'"]?([A-Za-z0-9][A-Za-z0-9_.@/-]{0,63})[`\'"]?';
/** A tool (MCP) server that did not start. The name is captured only from a closed character set. */
const TOOL_SERVER_FAILURES: readonly RegExp[] = [
  new RegExp(`\\bMCP client for ${SERVER_NAME} (?:failed to start|timed out)`, 'i'),
  new RegExp(`\\bThe ${SERVER_NAME} MCP server is not logged in`, 'i'),
  new RegExp(`\\b(?:failed|unable) to (?:start|launch|initiali[sz]e|connect to) (?:the )?MCP server ${SERVER_NAME}`, 'i'),
  new RegExp(`\\bMCP server ${SERVER_NAME}[:,]? (?:failed to start|failed to initiali[sz]e|startup failed|did not start|timed out)`, 'i'),
  new RegExp(`\\bmcp:\\s*${SERVER_NAME} failed\\b`, 'i'),
  new RegExp(`\\bMCP startup (?:incomplete|failed)\\b[^(\\n]*\\(failed:\\s*${SERVER_NAME}`, 'i'),
];
const TOOL_SERVER_FAILURE_WITHOUT_NAME = /\bMCP (?:client|server|startup)\b[^\n]*\b(?:failed to start|failed to initiali[sz]e|startup failed|did not start|startup incomplete)\b/i;

/** Start-up failures are one short sentence; a very long line is read only as far as that. */
const MAX_TOOL_SERVER_LINE_CHARS = 2000;

/** `{}` for a start-up failure that names no server; null when the line is about something else. */
export function matchToolServerFailure(line: string): { name?: string } | null {
  const text = line.slice(0, MAX_TOOL_SERVER_LINE_CHARS);
  for (const pattern of TOOL_SERVER_FAILURES) {
    const name = pattern.exec(text)?.[1];
    if (name) return { name };
  }
  return TOOL_SERVER_FAILURE_WITHOUT_NAME.test(text) ? {} : null;
}

const NETWORK_FAILURE = /network error|error sending request|connection (?:refused|reset|timed out|closed)|\bdns\b|\btls\b|handshake|stream (?:disconnected|closed)|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i;

export function classifyCodexDiagnostic(line: string): CodexDiagnostic {
  const { line: trimmed, loggedAt } = stripCodexLogTimestamp(line);
  const found = (diagnostic: Omit<CodexDiagnostic, 'line' | 'loggedAt'>): CodexDiagnostic =>
    ({ ...diagnostic, line: trimmed, ...(loggedAt ? { loggedAt } : {}) });
  const lower = trimmed.toLowerCase();
  const hasErrorLevel = /\berror\b/i.test(trimmed);
  const hasWarnLevel = /\bwarn\b/i.test(trimmed);

  if (
    lower.includes('failed to refresh available models')
    || lower.includes('timeout waiting for child process to exit')
  ) {
    return found({ category: 'models', fatal: false, level: 'warning' });
  }

  if (
    lower.includes('failed to terminate mcp process group')
    || lower.includes('failed to kill mcp process group')
  ) {
    return found({ category: 'mcp', fatal: false, level: 'warning' });
  }

  if (lower.includes('failed to delete shell snapshot')) {
    return found({ category: 'startup', fatal: false, level: 'warning' });
  }

  if (lower.includes('state db missing rollout path') || lower.includes('codex_core::rollout')) {
    return found({ category: 'unknown', fatal: false, level: 'info' });
  }

  // Before the sign-in rule: a tool server's own "401 Unauthorized" is not Codex being signed out.
  const toolServer = matchToolServerFailure(trimmed);
  if (toolServer) {
    return found({ category: 'tool-server', fatal: false, level: 'warning', ...(toolServer.name ? { toolServer: toolServer.name } : {}) });
  }

  if (
    lower.includes('unauthorized')
    || lower.includes('authentication')
    || lower.includes('forbidden')
    || lower.includes('login required')
  ) {
    return found({ category: 'auth', fatal: true, level: 'error' });
  }

  if (
    lower.includes('unknown model')
    || lower.includes('model not found')
    || lower.includes('invalid model')
  ) {
    return found({ category: 'models', fatal: true, level: 'error' });
  }

  if (isSessionNotFoundText(trimmed)) {
    return found({ category: 'session', fatal: true, level: 'error' });
  }

  if (
    lower.includes('permission denied')
    || lower.includes('sandbox')
    || lower.includes('dangerously-bypass-approvals-and-sandbox')
  ) {
    return found({
      category: 'sandbox',
      fatal: hasErrorLevel,
      level: hasErrorLevel ? 'error' : 'warning',
    });
  }

  if (NETWORK_FAILURE.test(trimmed)) {
    return found({ category: 'network', fatal: false, level: 'warning' });
  }

  if (hasWarnLevel) {
    return found({ category: 'unknown', fatal: false, level: 'warning' });
  }

  if (hasErrorLevel) {
    return found({ category: 'process', fatal: false, level: 'warning' });
  }

  return found({ category: 'unknown', fatal: false, level: 'info' });
}
