import { createHash } from 'crypto';
import * as path from 'path';
import type { LoopToolCallRecord } from '../../shared/types/loop.types';
import type { LoopInvocationActivity } from './loop-invocation-activity';

export interface LoopInvocationCaptureSnapshot {
  toolCalls: LoopToolCallRecord[];
  filesRead: string[];
  unresolvedToolCalls: boolean;
  finishReason?: string;
}

interface TrackedToolCall {
  id: string;
  startedAt: number;
  index: number;
}

const READ_FILE_TOOLS = new Set([
  'Read',
  'NotebookRead',
  'read_file',
  'readFile',
  'open_file',
  'openFile',
  'view_file',
  'viewFile',
]);

export function createLoopInvocationCapture(options: {
  workspaceDir: string;
  now?: () => number;
}): {
  recordActivity: (activity: LoopInvocationActivity) => void;
  finalize: (fallback?: { finishReason?: string }) => LoopInvocationCaptureSnapshot;
} {
  const now = options.now ?? Date.now;
  const toolCalls: LoopToolCallRecord[] = [];
  const pending = new Map<string, TrackedToolCall>();
  const filesRead: string[] = [];
  const filesReadSeen = new Set<string>();
  let anonymousSeq = 0;
  let finishReason: string | undefined;

  const rememberReadPath = (candidate: unknown): void => {
    const normalized = normalizeReadPath(candidate, options.workspaceDir);
    if (!normalized || filesReadSeen.has(normalized)) return;
    filesReadSeen.add(normalized);
    filesRead.push(normalized);
  };

  const recordActivity = (activity: LoopInvocationActivity): void => {
    const activityFinishReason = readString(activity.detail, 'finishReason');
    if (activityFinishReason) finishReason = activityFinishReason;

    if (activity.kind === 'tool_use') {
      const detail = activity.detail ?? {};
      const toolName = readToolName(activity);
      const input = readToolInput(detail);
      const id = readString(detail, 'id') ?? `anonymous-${anonymousSeq++}`;
      const startedAt = now();
      const argsHash = hashStable(`${toolName}:${stableStringify(input ?? scrubToolDetail(detail))}`);
      const index = toolCalls.length;
      toolCalls.push({ toolName, argsHash, success: true, durationMs: 0 });
      pending.set(id, { id, startedAt, index });

      if (READ_FILE_TOOLS.has(toolName) && input) {
        for (const key of ['file_path', 'path', 'filePath', 'filename', 'file']) {
          rememberReadPath(input[key]);
        }
      }
      return;
    }

    if (activity.kind === 'tool_result') {
      const detail = activity.detail ?? {};
      const id = readString(detail, 'id');
      const tracked = id ? pending.get(id) : firstPending(pending);
      if (!tracked) return;
      const content = readResultString(detail, 'result') ?? readResultString(detail, 'content') ?? activity.message;
      const success = readBoolean(detail, 'success') ?? (readBoolean(detail, 'isError') === true ? false : true);
      toolCalls[tracked.index] = {
        ...toolCalls[tracked.index],
        success,
        durationMs: Math.max(0, now() - tracked.startedAt),
        resultHash: hashStable(content),
      };
      pending.delete(tracked.id);
      return;
    }

    if (activity.kind === 'complete' || activity.kind === 'error') {
      const terminalAt = now();
      for (const tracked of pending.values()) {
        const existing = toolCalls[tracked.index];
        if (existing.durationMs === 0) {
          toolCalls[tracked.index] = {
            ...existing,
            durationMs: Math.max(0, terminalAt - tracked.startedAt),
          };
        }
      }
    }
  };

  return {
    recordActivity,
    finalize: (fallback) => {
      const finalFinishReason = finishReason ?? fallback?.finishReason;
      return {
        toolCalls: [...toolCalls],
        filesRead: [...filesRead],
        unresolvedToolCalls: pending.size > 0,
        ...(finalFinishReason ? { finishReason: finalFinishReason } : {}),
      };
    },
  };
}

export function extractFinishReasonFromResponse(response: unknown): string | undefined {
  const direct = readString(response, 'finishReason')
    ?? readString(response, 'stopReason')
    ?? readString(response, 'stop_reason');
  if (direct) return direct;
  const metadata = readRecord(response, 'metadata');
  const fromMetadata = readString(metadata, 'finishReason')
    ?? readString(metadata, 'stopReason')
    ?? readString(metadata, 'stop_reason');
  if (fromMetadata) return fromMetadata;
  const raw = readRecord(response, 'raw');
  return readString(raw, 'finishReason')
    ?? readString(raw, 'stopReason')
    ?? readString(raw, 'stop_reason');
}

function firstPending(pending: Map<string, TrackedToolCall>): TrackedToolCall | undefined {
  return pending.values().next().value as TrackedToolCall | undefined;
}

function readToolName(activity: LoopInvocationActivity): string {
  const detailName = readString(activity.detail, 'name');
  if (detailName) return detailName;
  const fromMessage = activity.message.replace(/^Using tool:\s*/i, '').trim();
  return fromMessage || 'unknown';
}

function readToolInput(detail: Record<string, unknown>): Record<string, unknown> | undefined {
  return readRecord(detail, 'input') ?? readRecord(detail, 'arguments');
}

function scrubToolDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...detail };
  delete copy['id'];
  delete copy['name'];
  delete copy['result'];
  delete copy['content'];
  delete copy['success'];
  delete copy['isError'];
  delete copy['finishReason'];
  delete copy['startedAt'];
  delete copy['durationMs'];
  return copy;
}

function hashStable(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortJson(value));
  } catch {
    return String(value);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function normalizeReadPath(candidate: unknown, workspaceDir: string): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return null;
  const workspace = path.resolve(workspaceDir);
  const absolute = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(workspace, trimmed);
  const relative = path.relative(workspace, absolute);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return absolute;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === 'string' && child.trim() ? child : undefined;
}

function readResultString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === 'string' ? child : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === 'boolean' ? child : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
