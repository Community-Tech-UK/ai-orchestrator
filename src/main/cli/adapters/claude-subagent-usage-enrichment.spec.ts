import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeSubagentUsageTracker,
  FINAL_SETTLE_MS,
  flushClaudeSubagentUsage,
  observeClaudeSubagentModel,
  observeClaudeSubagentUsage,
} from './claude-subagent-usage';
import type { ClaudeTranscriptLocation } from './claude-subagent-meta';

let root = '';
let location: ClaudeTranscriptLocation;
let helperDir = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aio-subagent-enrich-'));
  const cwd = '/example/project';
  location = { cwd, sessionId: 'session-1', configDir: root };
  helperDir = join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'session-1', 'subagents');
  mkdirSync(helperDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const meta = (agentId: string, body: Record<string, unknown>): void =>
  writeFileSync(join(helperDir, `agent-${agentId}.meta.json`), JSON.stringify({ description: 'private', ...body }));
const started = { type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'a1', tool_use_id: 'toolu_1' };
const progress = { type: 'system', subtype: 'task_progress', task_id: 'a1', usage: { total_tokens: 900, tool_uses: 3, duration_ms: 40 } };
const notice = { ...progress, subtype: 'task_notification' };
const helperFrame = (model: string, parent = 'toolu_1') =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { model, content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } });

function track(): ClaudeSubagentUsageTracker {
  const tracker = new ClaudeSubagentUsageTracker();
  tracker.setLocation(location);
  return tracker;
}

describe('Claude helper model and start details on the final sample', () => {
  it('uses the model seen on the helper own frames and adds fork, depth and mode from its meta file', () => {
    meta('a1', { agentType: 'general-purpose', requestShape: 'background', spawnDepth: 2, isFork: true, model: 'sonnet' });
    const tracker = track();
    tracker.observe(started);
    tracker.observeAssistant(helperFrame('claude-sonnet-5-5'));
    expect(tracker.observe(progress)).toMatchObject({ final: false });
    expect(tracker.observe(progress)).not.toHaveProperty('model');
    expect(tracker.observe(notice)).toBeNull();
    expect(tracker.flush()).toEqual([expect.objectContaining({
      toolUseId: 'toolu_1', final: true, model: 'claude-sonnet-5-5', modelSource: 'stream',
      agentType: 'general-purpose', fork: true, depth: 2, mode: 'background',
    })]);
  });

  it('falls back to the helper transcript, then to the model the spawn asked for', () => {
    meta('a1', { requestShape: 'foreground', spawnDepth: 1, model: 'opus' });
    writeFileSync(join(helperDir, 'agent-a1.jsonl'), `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } })}\n`);
    const withTranscript = track();
    withTranscript.observe(started);
    withTranscript.observe(progress);
    expect(withTranscript.flush()).toEqual([expect.objectContaining({
      model: 'claude-opus-5-5', modelSource: 'transcript', depth: 1, mode: 'foreground',
    })]);

    rmSync(join(helperDir, 'agent-a1.jsonl'));
    const requestedOnly = track();
    requestedOnly.observe(started);
    requestedOnly.observe(progress);
    expect(requestedOnly.flush()).toEqual([expect.objectContaining({ model: 'opus', modelSource: 'requested' })]);
  });

  it('keeps unknown fork metadata absent, while recording an explicit false', () => {
    for (const fork of [undefined, false]) {
      meta('a1', fork === undefined ? {} : { isFork: fork });
      const tracker = track();
      tracker.observe(started);
      tracker.observe(progress);
      const [sample] = tracker.flush();
      if (fork === undefined) expect(sample).not.toHaveProperty('fork');
      else expect(sample.fork).toBe(false);
    }
  });

  it('keeps the stream model when no location is known and ignores main-thread and synthetic frames', () => {
    const tracker = new ClaudeSubagentUsageTracker();
    tracker.observe(started);
    tracker.observeAssistant({ type: 'assistant', message: { model: 'claude-opus-5-5' } });
    tracker.observeAssistant(helperFrame('<synthetic>'));
    tracker.observeAssistant(helperFrame('claude-haiku-5-5'));
    tracker.observe(progress);
    const [sample] = tracker.flush();
    expect(sample).toMatchObject({ model: 'claude-haiku-5-5', modelSource: 'stream' });
    expect(sample).not.toHaveProperty('fork');
  });

  it('finds the meta file by tool-use id when no task_started was seen', () => {
    meta('a9', { toolUseId: 'toolu_9', spawnDepth: 3, requestShape: 'background' });
    const tracker = track();
    tracker.observe({ type: 'system', subtype: 'task_progress', tool_use_id: 'toolu_9', usage: { total_tokens: 5, tool_uses: 1, duration_ms: 2 } });
    expect(tracker.flush()).toEqual([expect.objectContaining({ toolUseId: 'toolu_9', depth: 3, mode: 'background' })]);
  });

  it('never leaks the meta description and survives an unreadable location', () => {
    meta('a1', { description: 'do not store', spawnDepth: 1 });
    const tracker = track();
    tracker.observe(started);
    tracker.observe(progress);
    expect(JSON.stringify(tracker.flush())).not.toContain('do not store');

    const broken = new ClaudeSubagentUsageTracker();
    broken.setLocation({ cwd: '/nowhere', sessionId: '../bad' });
    broken.observe(started);
    broken.observe(progress);
    expect(broken.flush()).toEqual([expect.objectContaining({ final: true, finalContextTokens: 900 })]);
  });

  it('is wired through the host helpers used by the adapter and the worker proxy', () => {
    meta('a1', { requestShape: 'background', spawnDepth: 1 });
    const host = new EventEmitter();
    const seen = vi.fn();
    host.on('subagent_usage', seen);
    observeClaudeSubagentUsage(host, started, location);
    observeClaudeSubagentModel(host, helperFrame('claude-sonnet-5-5'));
    observeClaudeSubagentUsage(host, progress, location);
    flushClaudeSubagentUsage(host);
    expect(seen.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ final: false }),
      expect.objectContaining({ final: true, model: 'claude-sonnet-5-5', modelSource: 'stream', mode: 'background', depth: 1 }),
    ]);
  });
});

const transcriptLine = (body: Record<string, unknown>): string =>
  `${JSON.stringify({ type: 'assistant', message: body })}\n`;
const msgOne = {
  id: 'msg_1', model: 'claude-sonnet-5-5',
  usage: { input_tokens: 2, output_tokens: 199, cache_read_input_tokens: 0, cache_creation_input_tokens: 29208,
    cache_creation: { ephemeral_5m_input_tokens: 29208, ephemeral_1h_input_tokens: 0 } },
};
const msgTwo = {
  id: 'msg_2', model: 'claude-sonnet-5-5',
  usage: { input_tokens: 2, output_tokens: 66, cache_read_input_tokens: 29208, cache_creation_input_tokens: 2051,
    cache_creation: { ephemeral_5m_input_tokens: 2051, ephemeral_1h_input_tokens: 0 } },
};
const bothMessages = {
  inputTokens: 4, outputTokens: 265, cacheReadTokens: 29208, cacheWriteTokens: 31259,
  cacheWrite5mTokens: 31259, cacheWrite1hTokens: 0,
};
// $0.0837263 at the repo rates (claude-sonnet-5-5: $2/M input, $10/M output,
// cache read 0.05x input, cache write 5m 1.25x input) — the check-2 figure.
const bothMessagesCost = 0.0837263;

describe('Claude helper transcript sum at the finish notification (LT-1091)', () => {
  function drive(): { host: EventEmitter; seen: ReturnType<typeof vi.fn> } {
    const host = new EventEmitter();
    const seen = vi.fn();
    host.on('subagent_usage', seen);
    observeClaudeSubagentUsage(host, started, location);
    observeClaudeSubagentUsage(host, progress, location);
    return { host, seen };
  }

  it('counts a helper final message that lands after the finish notification', () => {
    meta('a1', { requestShape: 'background', spawnDepth: 1, model: 'sonnet' });
    writeFileSync(join(helperDir, 'agent-a1.jsonl'), transcriptLine(msgOne));
    const { host, seen } = drive();
    observeClaudeSubagentUsage(host, notice, location);
    expect(seen.mock.calls.map((call) => call[0]).filter((sample) => sample.final)).toHaveLength(0);
    appendFileSync(join(helperDir, 'agent-a1.jsonl'), transcriptLine(msgTwo));
    flushClaudeSubagentUsage(host);
    const finals = seen.mock.calls.map((call) => call[0]).filter((sample) => sample.final);
    expect(finals).toHaveLength(1);
    expect(finals[0].transcriptUsage).toEqual(bothMessages);
    expect(finals[0].transcriptCost).toBeCloseTo(bothMessagesCost, 5);
  });

  it('does not book zeros when the whole transcript lands after the finish notification', () => {
    meta('a1', { requestShape: 'background', spawnDepth: 1, model: 'sonnet' });
    const { host, seen } = drive();
    observeClaudeSubagentUsage(host, notice, location);
    writeFileSync(join(helperDir, 'agent-a1.jsonl'), transcriptLine(msgOne) + transcriptLine(msgTwo));
    flushClaudeSubagentUsage(host);
    const finals = seen.mock.calls.map((call) => call[0]).filter((sample) => sample.final);
    expect(finals).toHaveLength(1);
    expect(finals[0].transcriptUsage).toEqual(bothMessages);
    expect(finals[0].transcriptCost).toBeCloseTo(bothMessagesCost, 5);
  });

  it('ignores a duplicate finish notification while the final sum is pending', () => {
    meta('a1', { requestShape: 'background', spawnDepth: 1, model: 'sonnet' });
    writeFileSync(join(helperDir, 'agent-a1.jsonl'), transcriptLine(msgOne));
    const { host, seen } = drive();
    observeClaudeSubagentUsage(host, notice, location);
    appendFileSync(join(helperDir, 'agent-a1.jsonl'), transcriptLine(msgTwo));
    observeClaudeSubagentUsage(host, notice, location);
    flushClaudeSubagentUsage(host);
    const finals = seen.mock.calls.map((call) => call[0]).filter((sample) => sample.final);
    expect(finals).toHaveLength(1);
    expect(finals[0].transcriptUsage).toEqual(bothMessages);
  });

  it('settles a deferred final on its own timer', () => {
    vi.useFakeTimers();
    try {
      meta('a1', { requestShape: 'background', spawnDepth: 1, model: 'sonnet' });
      writeFileSync(join(helperDir, 'agent-a1.jsonl'), transcriptLine(msgOne) + transcriptLine(msgTwo));
      const onFinal = vi.fn();
      const tracker = new ClaudeSubagentUsageTracker({ onFinal });
      tracker.setLocation(location);
      tracker.observe(started);
      tracker.observe(progress);
      expect(tracker.observe(notice)).toBeNull();
      expect(onFinal).not.toHaveBeenCalled();
      vi.advanceTimersByTime(FINAL_SETTLE_MS);
      expect(onFinal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ final: true, transcriptUsage: bothMessages }));
      expect(tracker.flush()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
