/**
 * Bounded, read-only access to a Claude helper agent's own files.
 *
 * Claude Code keeps one pair of files per helper under
 * `<config>/projects/<cwd>/<session>/subagents/`: `agent-<id>.meta.json`
 * (how it was started) and `agent-<id>.jsonl` (its transcript). The stream does
 * not always carry a helper's own frames, so these files are the dependable
 * source for fork, depth, foreground or background, and the model it really ran.
 *
 * Only a fixed list of small scalar fields leaves this module. The meta file's
 * model-written `description` is never read into a result.
 */

import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { claudeProjectDirs } from './claude-transcript-registry';

export interface ClaudeTranscriptLocation {
  cwd: string;
  /** The parent session's CLI session id (the directory the helpers live under). */
  sessionId: string;
  /** `CLAUDE_CONFIG_DIR` for account-pool profiles; the default config dir when absent. */
  configDir?: string;
}

/** The location for a live session, or null when its working directory or session id is not known yet. */
export function claudeTranscriptLocation(
  cwd: string | undefined,
  sessionId: string | null | undefined,
  configDir?: string,
): ClaudeTranscriptLocation | null {
  return cwd && sessionId ? { cwd, sessionId, ...(configDir ? { configDir } : {}) } : null;
}

export interface ClaudeSubagentMeta {
  agentType?: string;
  isFork?: boolean;
  spawnDepth?: number;
  requestShape?: 'foreground' | 'background';
  /** The alias the spawn asked for (`sonnet`, `opus`, `inherit`); not proof of the model that ran. */
  requestedModel?: string;
}

export interface ClaudeSubagentRef {
  agentId?: string;
  toolUseId?: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_LABEL = /^[A-Za-z0-9._\[\]:-]{1,100}$/;
const MAX_META_BYTES = 64 * 1024;
const TRANSCRIPT_TAIL_BYTES = 128 * 1024;
const MAX_SCANNED_METAS = 60;
const MAX_DEPTH = 32;

function subagentDirs(location: ClaudeTranscriptLocation): string[] {
  if (!location.cwd || !SAFE_ID.test(location.sessionId)) return [];
  return claudeProjectDirs(location.cwd, location.configDir).map((dir) => join(dir, location.sessionId, 'subagents'));
}

function readBounded(path: string, maxBytes: number, tail: boolean): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (!tail && size > maxBytes) return undefined;
    const start = tail ? Math.max(0, size - maxBytes) : 0;
    const buffer = Buffer.alloc(size - start);
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytes).toString('utf8');
    if (tail && start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* fail soft */ }
    }
  }
}

function parseRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function pickMeta(record: Record<string, unknown>): ClaudeSubagentMeta {
  const meta: ClaudeSubagentMeta = {};
  const type = record['agentType'];
  if (typeof type === 'string' && SAFE_LABEL.test(type)) meta.agentType = type;
  if (typeof record['isFork'] === 'boolean') meta.isFork = record['isFork'];
  const depth = record['spawnDepth'];
  if (typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 && depth <= MAX_DEPTH) meta.spawnDepth = depth;
  const shape = record['requestShape'];
  if (shape === 'foreground' || shape === 'background') meta.requestShape = shape;
  const model = record['model'];
  if (typeof model === 'string' && SAFE_LABEL.test(model)) meta.requestedModel = model;
  return meta;
}

/** Locate a helper by agent id, or by tool-use id among the newest meta files. */
export function locateClaudeSubagent(
  location: ClaudeTranscriptLocation,
  ref: ClaudeSubagentRef,
): { agentId: string; meta: ClaudeSubagentMeta } | undefined {
  const dirs = subagentDirs(location);
  if (ref.agentId !== undefined) {
    if (!SAFE_ID.test(ref.agentId)) return undefined;
    for (const dir of dirs) {
      const record = parseRecord(readBounded(join(dir, `agent-${ref.agentId}.meta.json`), MAX_META_BYTES, false));
      if (record) return { agentId: ref.agentId, meta: pickMeta(record) };
    }
    return undefined;
  }
  if (!ref.toolUseId || !SAFE_ID.test(ref.toolUseId)) return undefined;
  for (const dir of dirs) {
    let names: { name: string; mtimeMs: number }[];
    try {
      names = readdirSync(dir)
        .filter((name) => /^agent-[A-Za-z0-9_-]{1,128}\.meta\.json$/.test(name))
        .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
    } catch {
      continue;
    }
    names.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { name } of names.slice(0, MAX_SCANNED_METAS)) {
      const record = parseRecord(readBounded(join(dir, name), MAX_META_BYTES, false));
      if (record?.['toolUseId'] === ref.toolUseId) {
        return { agentId: name.slice('agent-'.length, -'.meta.json'.length), meta: pickMeta(record) };
      }
    }
  }
  return undefined;
}

export function readClaudeSubagentMeta(location: ClaudeTranscriptLocation, ref: ClaudeSubagentRef): ClaudeSubagentMeta | undefined {
  return locateClaudeSubagent(location, ref)?.meta;
}

/** The model of the helper's newest real assistant record (synthetic error records are skipped). */
export function readClaudeSubagentTranscriptModel(
  location: ClaudeTranscriptLocation,
  ref: { agentId: string },
): string | undefined {
  if (!SAFE_ID.test(ref.agentId)) return undefined;
  for (const dir of subagentDirs(location)) {
    const tail = readBounded(join(dir, `agent-${ref.agentId}.jsonl`), TRANSCRIPT_TAIL_BYTES, true);
    if (!tail) continue;
    for (const line of tail.split('\n').reverse()) {
      const record = parseRecord(line);
      const message = record?.['type'] === 'assistant' ? record['message'] : undefined;
      const model = message && typeof message === 'object' ? (message as Record<string, unknown>)['model'] : undefined;
      if (typeof model === 'string' && model !== '<synthetic>' && SAFE_LABEL.test(model)) return model;
    }
  }
  return undefined;
}

/** Path of a helper's own transcript file when it exists, or undefined. Fail-soft. */
export function claudeSubagentTranscriptPath(
  location: ClaudeTranscriptLocation,
  agentId: string,
): string | undefined {
  try {
    if (!SAFE_ID.test(agentId)) return undefined;
    for (const dir of subagentDirs(location)) {
      const transcriptPath = join(dir, `agent-${agentId}.jsonl`);
      try {
        if (statSync(transcriptPath).isFile()) return transcriptPath;
      } catch {
        // Missing on this candidate; try the next directory.
      }
    }
  } catch {
    // Location cannot be listed; report no transcript rather than failing teardown.
  }
  return undefined;
}

/** Aggregated token usage from a helper's own transcript. Only scalar fields leave this module. */
export interface ClaudeSubagentTranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 5-minute cache writes (from `usage.cache_creation.ephemeral_5m_input_tokens`). */
  cacheWrite5mTokens: number;
  /** 1-hour cache writes (from `usage.cache_creation.ephemeral_1h_input_tokens`). */
  cacheWrite1hTokens: number;
  /** The model of each request, to price per-message. */
  models: string[];
}

const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const SAFE_MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Sum the usage in a helper's own transcript. Deduplicates by message id
 * (one response is written as several lines). Reads no model-written text;
 * only scalar fields leave this module. Fail-soft: a missing or oversized
 * file returns undefined, never throws.
 */
export function sumClaudeSubagentTranscriptUsage(
  location: ClaudeTranscriptLocation,
  ref: { agentId: string },
): ClaudeSubagentTranscriptUsage | undefined {
  if (!SAFE_ID.test(ref.agentId)) return undefined;
  for (const dir of subagentDirs(location)) {
    const text = readBounded(join(dir, `agent-${ref.agentId}.jsonl`), MAX_TRANSCRIPT_BYTES, false);
    if (text === undefined) continue;
    const seen = new Set<string>();
    const totals: ClaudeSubagentTranscriptUsage = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, models: [],
    };
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      const record = parseRecord(line);
      if (record?.['type'] !== 'assistant') continue;
      const message = record['message'];
      if (!message || typeof message !== 'object') continue;
      const msg = message as Record<string, unknown>;
      const usage = msg['usage'];
      if (!usage || typeof usage !== 'object') continue;
      const u = usage as Record<string, unknown>;
      const messageId = typeof msg['id'] === 'string' ? msg['id'] : '';
      if (messageId && !SAFE_MESSAGE_ID.test(messageId)) continue;
      const key = messageId || `line-${line.length}-${line.slice(0, 32)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
      totals.inputTokens += num(u['input_tokens']);
      totals.outputTokens += num(u['output_tokens']);
      totals.cacheReadTokens += num(u['cache_read_input_tokens']);
      const cacheWrite = num(u['cache_creation_input_tokens']);
      totals.cacheWriteTokens += cacheWrite;
      const split = u['cache_creation'];
      if (split && typeof split === 'object') {
        const s = split as Record<string, unknown>;
        totals.cacheWrite5mTokens += num(s['ephemeral_5m_input_tokens']);
        totals.cacheWrite1hTokens += num(s['ephemeral_1h_input_tokens']);
      }
      const model = msg['model'];
      if (typeof model === 'string' && model !== '<synthetic>' && SAFE_LABEL.test(model)) {
        totals.models.push(model);
      }
    }
    return totals;
  }
  return undefined;
}
