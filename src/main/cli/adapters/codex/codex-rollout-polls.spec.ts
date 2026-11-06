import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { polledCommandsInRollout, readPolledCommands } from './codex-rollout-polls';

const state = vi.hoisted(() => ({ row: undefined as { path: string } | undefined, stateDir: '', closed: 0 }));
vi.mock('../../../db/better-sqlite3-driver', () => ({
  defaultDriverFactory: () => ({ prepare: () => ({ get: () => state.row }), close: () => { state.closed++; } }),
}));
vi.mock('./codex-home-manager', () => ({
  getAioCodexStateDir: () => state.stateDir,
  getAioCodexSessionsDir: () => join(state.stateDir, 'sessions'),
}));

const FINISHED = Date.parse('2026-11-05T21:55:59.000Z');
const at = (offsetMs: number) => new Date(FINISHED + offsetMs).toISOString();
const line = (offsetMs: number, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: at(offsetMs), type: 'response_item', payload });

describe('polledCommandsInRollout', () => {
  let dir: string;
  let path: string;
  const polled = (...lines: string[]) => {
    writeFileSync(path, lines.join('\n') + '\n');
    return polledCommandsInRollout(path, [{ processId: '18479', finishedAt: FINISHED }]);
  };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-polls-')); path = join(dir, 'rollout.jsonl'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('counts a code-mode poll that returned after the command finished', () => {
    expect(polled(
      line(9_000, { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'text(await tools.write_stdin({session_id:18479,chars:"","yield_time_ms":1000}));' }),
      line(10_000, { type: 'custom_tool_call_output', call_id: 'c1', output: [] }),
    )).toEqual(new Set(['18479']));
  });

  it('counts a direct write_stdin poll', () => {
    expect(polled(
      line(1_000, { type: 'function_call', name: 'write_stdin', call_id: 'c1', arguments: '{"session_id":18479,"chars":""}' }),
      line(2_000, { type: 'function_call_output', call_id: 'c1', output: '' }),
    )).toEqual(new Set(['18479']));
  });

  it('counts a poll that was waiting when the command exited', () => {
    expect(polled(
      line(-4_000, { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'tools.write_stdin({session_id:18479})' }),
      line(-200, { type: 'custom_tool_call_output', call_id: 'c1', output: [] }),
    )).toEqual(new Set(['18479']));
  });

  it('does not count a poll that returned while the command was still running', () => {
    expect(polled(
      line(-40_000, { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'tools.write_stdin({session_id:18479})' }),
      line(-30_000, { type: 'custom_tool_call_output', call_id: 'c1', output: [] }),
    )).toEqual(new Set());
  });

  it('does not count a poll of another command, or one with no result yet', () => {
    expect(polled(
      line(1_000, { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'tools.write_stdin({session_id:999})' }),
      line(2_000, { type: 'custom_tool_call_output', call_id: 'c1', output: [] }),
      line(3_000, { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'tools.write_stdin({session_id:18479})' }),
    )).toEqual(new Set());
  });

  it('skips a torn or foreign line', () => {
    expect(polled(
      '{"timestamp":"2026-11-05', 'not json with _call',
      line(1_000, { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'tools.write_stdin({session_id:18479})' }),
      line(2_000, { type: 'custom_tool_call_output', call_id: 'c1', output: [] }),
    )).toEqual(new Set(['18479']));
  });

  it('reports an unreadable transcript instead of guessing', () => {
    expect(() => polledCommandsInRollout(join(dir, 'missing.jsonl'), [])).toThrow();
  });

  describe('finding the transcript for a thread', () => {
    const poll = [
      line(1_000, { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'tools.write_stdin({session_id:18479})' }),
      line(2_000, { type: 'custom_tool_call_output', call_id: 'c1', output: [] }),
    ].join('\n') + '\n';
    const command = [{ processId: '18479', finishedAt: FINISHED }];
    beforeEach(() => { state.stateDir = dir; state.row = undefined; state.closed = 0; });

    it('reads the recorded path', () => {
      writeFileSync(path, poll);
      state.row = { path };
      expect(readPolledCommands('thread-1', command)).toEqual(new Set(['18479']));
      expect(state.closed).toBe(1);
    });

    it('falls back to the persistent copy of a session-home transcript', () => {
      mkdirSync(join(dir, 'sessions/2026/11'), { recursive: true });
      writeFileSync(join(dir, 'sessions/2026/11/rollout.jsonl'), poll);
      state.row = { path: join(dir, 'gone-home/sessions/2026/11/rollout.jsonl') };
      expect(readPolledCommands('thread-1', command)).toEqual(new Set(['18479']));
    });

    it('throws when the thread has no transcript, and still closes the database', () => {
      expect(() => readPolledCommands('thread-1', command)).toThrow('no recorded transcript');
      state.row = { path: join(dir, 'missing.jsonl') };
      expect(() => readPolledCommands('thread-1', command)).toThrow('missing');
      expect(state.closed).toBe(2);
    });
  });
});
