import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import { getAioCodexSessionsDir, getAioCodexStateDir } from './codex-home-manager';
import { persistentRolloutPathFor } from './codex-state-leak-snapshot';

/** One turn's polls fit well inside this; anything older only costs an extra wake. */
const ROLLOUT_TAIL_BYTES = 4 * 1024 * 1024;
/** Harness stamps a finish on receipt, slightly after Codex stamps the poll that caught it. */
const POLL_CLOCK_SLACK_MS = 1_500;
const CODE_MODE_POLL = /write_stdin\(\{[^}]*?session_id["']?\s*:\s*(\d+)/g;
const DIRECT_POLL = /"session_id"\s*:\s*(\d+)/;

export interface FinishedCommand {
  processId: string;
  finishedAt: number;
}

/** App-server events cannot show this: a poll that returns a command's exit emits nothing of its own. */
export function readPolledCommands(threadId: string, commands: FinishedCommand[]): Set<string> {
  return polledCommandsInRollout(rolloutPathForThread(threadId), commands);
}

function rolloutPathForThread(threadId: string): string {
  const db = defaultDriverFactory(join(getAioCodexStateDir(), 'state_5.sqlite'), { readonly: true });
  try {
    const row = db.prepare('SELECT rollout_path AS path FROM threads WHERE id = ?').get<{ path: string }>(threadId);
    if (!row) throw new Error('Codex has no recorded transcript for this thread');
    if (existsSync(row.path)) return row.path;
    const persistent = persistentRolloutPathFor(row.path, getAioCodexSessionsDir());
    if (persistent && existsSync(persistent)) return persistent;
    throw new Error('The recorded Codex transcript is missing');
  } finally {
    db.close();
  }
}

/** Synchronous so the result is known before the turn's end moves the session to idle. */
export function polledCommandsInRollout(path: string, commands: FinishedCommand[]): Set<string> {
  const finishedAt = new Map(commands.map((command) => [command.processId, command.finishedAt]));
  const pollsByCall = new Map<string, string[]>();
  const polled = new Set<string>();
  for (const line of readTailLines(path)) {
    if (!line.includes('_call')) continue;
    const entry = parseRolloutLine(line);
    if (!entry) continue;
    const { payload, timestamp } = entry;
    if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
      const processIds = pollTargets(payload);
      if (processIds.length > 0 && payload.call_id) pollsByCall.set(payload.call_id, processIds);
    } else if ((payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') && payload.call_id) {
      for (const processId of pollsByCall.get(payload.call_id) ?? []) {
        const finished = finishedAt.get(processId);
        if (finished !== undefined && timestamp >= finished - POLL_CLOCK_SLACK_MS) polled.add(processId);
      }
    }
  }
  return polled;
}

interface RolloutCall {
  type?: string;
  name?: string;
  input?: string;
  arguments?: string;
  call_id?: string;
}

function pollTargets(call: RolloutCall): string[] {
  if (call.name === 'write_stdin') {
    const direct = DIRECT_POLL.exec(call.arguments ?? '')?.[1];
    return direct ? [direct] : [];
  }
  return [...(call.input ?? '').matchAll(CODE_MODE_POLL)].map((match) => match[1]);
}

function parseRolloutLine(line: string): { payload: RolloutCall; timestamp: number } | null {
  try {
    const entry = JSON.parse(line) as { timestamp?: string; payload?: RolloutCall };
    const timestamp = Date.parse(entry.timestamp ?? '');
    return entry.payload && Number.isFinite(timestamp) ? { payload: entry.payload, timestamp } : null;
  } catch {
    return null;
  }
}

function readTailLines(path: string): string[] {
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (length < size) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}
