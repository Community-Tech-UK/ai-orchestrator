/**
 * Builders for fake Claude transcripts, used only by the usage-insight specs.
 * Everything here is invented; no real conversation text is ever used.
 */

import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CLAUDE_PINNED_MODELS } from '../../shared/types/provider.types';

/** The model every fake request uses unless a spec names another one. */
export const FAKE_MODEL: string = CLAUDE_PINNED_MODELS.OPUS_5;

export interface FakeRequest {
  /** Response id. Several lines with the same id are one response. */
  id: string;
  at: number;
  sessionId?: string;
  requestId?: string;
  model?: string;
  input?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
  sidechain?: boolean;
  agentId?: string;
}

export function assistantLine(request: FakeRequest): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: request.sessionId ?? 'session-a',
    timestamp: new Date(request.at).toISOString(),
    requestId: request.requestId ?? `req_${request.id}`,
    isSidechain: request.sidechain === true,
    ...(request.agentId ? { agentId: request.agentId } : {}),
    message: {
      id: `msg_${request.id}`,
      model: request.model ?? FAKE_MODEL,
      role: 'assistant',
      content: [{ type: 'text', text: 'FAKE-REPLY' }],
      usage: {
        input_tokens: request.input ?? 100,
        cache_creation_input_tokens: request.cacheWrite ?? 0,
        cache_read_input_tokens: request.cacheRead ?? 0,
        output_tokens: request.output ?? 50,
      },
    },
  });
}

export function toolResultLine(options: { chars: number; at?: number; sessionId?: string; sidechain?: boolean; agentId?: string }): string {
  return JSON.stringify({
    type: 'user',
    sessionId: options.sessionId ?? 'session-a',
    timestamp: new Date(options.at ?? 0).toISOString(),
    isSidechain: options.sidechain === true,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'x'.repeat(options.chars) }] },
  });
}

export function compactionLine(at = 0): string {
  return JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(at).toISOString(), content: 'Conversation compacted' });
}

/** Writes a transcript, one line per entry, each ending in a newline. */
export function writeTranscript(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
}

export function appendTranscript(path: string, text: string): void {
  appendFileSync(path, text);
}

/** Sets the file's modified time, which decides whether the scanner opens it. */
export function setModified(path: string, at: number): void {
  const seconds = at / 1000;
  utimesSync(path, seconds, seconds);
}
