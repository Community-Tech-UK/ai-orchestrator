import { createHash } from 'crypto';

import { generateId } from '../../../shared/utils/id-generator';

export interface ClaudeToolUseContext {
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudePermissionDetails {
  action: string;
  path: string;
  displayPath: string;
}

/**
 * Detect whether a tool_result error content indicates a permission denial.
 * Claude CLI has changed its denial wording across versions, so we match
 * several known patterns rather than a single literal string.
 */
export function isPermissionDenialContent(content: string): boolean {
  const lower = content.toLowerCase();
  const patterns = [
    "haven't granted it yet",
    "hasn't been granted",
    "permission denied",
    "not allowed to",
    "not permitted",
    "requires permission",
    "does not have permission",
    "need permission",
    "must grant permission",
    "allow this tool",
    "tool is not approved",
    "denied by permission",
    "permission to use this tool",
    "tool use is not allowed",
    "is not allowed in",
    "isn't allowed",
    "not authorized",
  ];
  const claudeRequestedPermissionPattern =
    /\bclaude requested permissions? to (?:access|add|change|create|delete|edit|execute|modify|move|open|read|remove|rename|run|update|use|view|write)\b/i;

  return patterns.some(p => lower.includes(p))
    || claudeRequestedPermissionPattern.test(content);
}

export function extractPermissionDetails(
  content: string,
  toolUseId: string | undefined,
  toolUseContexts: ReadonlyMap<string, ClaudeToolUseContext>
): ClaudePermissionDetails {
  const normalizedContent = content.replace(/\s+/g, ' ').trim();

  let action: string | undefined;
  let path: string | undefined;
  let displayPath: string | undefined;

  const patterns: RegExp[] = [
    /permissions? to (\w+) to (.+?)(?:,| but\b| because\b| which\b|\.(?:\s|$)|$)/i,
    /permissions? to (\w+) on (.+?)(?:,| but\b| because\b| which\b|\.(?:\s|$)|$)/i,
    /permissions? to (\w+) for (.+?)(?:,| but\b| because\b| which\b|\.(?:\s|$)|$)/i,
    /permissions? to (access|add|change|create|delete|edit|modify|move|open|read|remove|rename|update|view|write) (.+?)(?:,| but\b| because\b| which\b|\.(?:\s|$)|$)/i
  ];

  for (const pattern of patterns) {
    const match = normalizedContent.match(pattern);
    if (match) {
      action = match[1]?.trim().toLowerCase();
      path = match[2]?.trim();
      if (action && path) {
        break;
      }
    }
  }

  const toolContext = toolUseId ? toolUseContexts.get(toolUseId) : undefined;
  if (toolContext) {
    if (!action) {
      action = toolContext.name.toLowerCase();
    }
    if (!path) {
      const extractedTarget = extractPermissionTargetFromToolInput(toolContext.input);
      path = extractedTarget?.rawValue;
      displayPath = extractedTarget?.displayValue;
    }
  }

  if (!action) {
    action = 'access';
  }
  if (!path) {
    path = 'a file';
  }
  if (!displayPath) {
    displayPath = summarizeClaudeLogText(path);
  }

  return {
    action,
    path,
    displayPath
  };
}

export function createPermissionKey(action: string, path: string): string {
  const digest = createHash('sha256')
    .update(`${action}\u0000${path}`)
    .digest('hex')
    .slice(0, 16);
  return `${action}:${digest}`;
}

export function createApprovalTraceId(kind: string): string {
  return `approval-${kind}-${generateId()}`;
}

function extractPermissionTargetFromToolInput(
  input: Record<string, unknown>
): { rawValue: string; displayValue: string } | undefined {
  const preferredKeys = [
    'file_path',
    'path',
    'filepath',
    'target_file',
    'target',
    'destination',
    'url',
    'uri'
  ];

  for (const key of preferredKeys) {
    const described = describePermissionTarget(key, input[key]);
    if (described) {
      return described;
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const described = describePermissionTarget(key, value);
    if (described) {
      return described;
    }
  }

  return undefined;
}

function describePermissionTarget(
  key: string,
  value: unknown
): { rawValue: string; displayValue: string } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalizedKey = key.toLowerCase();
  const isPathLikeKey = normalizedKey === 'file_path'
    || normalizedKey === 'path'
    || normalizedKey === 'filepath'
    || normalizedKey === 'target_file'
    || normalizedKey === 'target'
    || normalizedKey === 'destination'
    || normalizedKey === 'url'
    || normalizedKey === 'uri';
  const looksLikePath = trimmed.startsWith('/')
    || trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || /^[A-Za-z]:[\\/]/.test(trimmed)
    || trimmed.includes('/')
    || trimmed.includes('\\');
  const looksLikeUrl = /^https?:\/\//i.test(trimmed);

  if (isPathLikeKey || looksLikePath || looksLikeUrl) {
    return {
      rawValue: trimmed,
      displayValue: summarizeClaudeLogText(trimmed)
    };
  }

  return {
    rawValue: trimmed,
    displayValue: `${normalizedKey} (${trimmed.length} chars)`
  };
}

export function summarizeClaudeLogText(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}... (${normalized.length} chars)`;
}
