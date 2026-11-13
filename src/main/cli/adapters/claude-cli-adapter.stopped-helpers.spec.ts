import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../../shared/types/instance.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';

type Ingress = {
  processCliMessage(message: unknown): void;
  handleExit(code: number | null, signal: NodeJS.Signals | null): void;
  reportStoppedHelpers(): void;
};

function feedTaskFrames(ingress: Ingress, task: string, toolUseId: string): void {
  ingress.processCliMessage({
    type: 'system',
    subtype: 'task_started',
    task_type: 'local_agent',
    task_id: task,
    tool_use_id: toolUseId,
  });
  ingress.processCliMessage({
    type: 'system',
    subtype: 'task_progress',
    task_type: 'local_agent',
    task_id: task,
    tool_use_id: toolUseId,
    usage: { total_tokens: 50, tool_uses: 4, duration_ms: 600 },
  });
}

function finishTask(ingress: Ingress, task: string, toolUseId: string): void {
  ingress.processCliMessage({
    type: 'system',
    subtype: 'task_notification',
    task_type: 'local_agent',
    task_id: task,
    tool_use_id: toolUseId,
    usage: { total_tokens: 50, tool_uses: 4, duration_ms: 600 },
  });
}

function stoppedHelpersOf(message: OutputMessage): unknown {
  return message.metadata?.['stoppedHelpers'];
}

describe('ClaudeCliAdapter stopped helper capture', () => {
  it('captures live helpers on exit with the settled wording and record shape', () => {
    const adapter = new ClaudeCliAdapter();
    const outputs: OutputMessage[] = [];
    adapter.on('output', (message: OutputMessage) => outputs.push(message));
    const ingress = adapter as unknown as Ingress;
    feedTaskFrames(ingress, 'agent-1', 'toolu-1');
    ingress.handleExit(null, 'SIGKILL');
    const notices = outputs.filter((message) => stoppedHelpersOf(message) !== undefined);
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(notice.type).toBe('system');
    expect(notice.content).toBe('Stopped 1 helper agent that had not finished.');
    const records = stoppedHelpersOf(notice) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record['toolUseId']).toBe('toolu-1');
    expect(record['agentId']).toBe('agent-1');
    expect(record['toolUseCount']).toBe(4);
    expect(typeof record['lastActivityAt']).toBe('number');
    expect(typeof record['sessionId']).toBe('string');
    expect(record['transcriptPath']).toBeUndefined();
  });

  it('captures the old CLI session id and the helper transcript path', () => {
    const root = mkdtempSync(join(tmpdir(), 'aio-stopped-helpers-'));
    const cwd = '/example/project';
    const helperDir = join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'session-live', 'subagents');
    mkdirSync(helperDir, { recursive: true });
    const transcriptPath = join(helperDir, 'agent-a1.jsonl');
    writeFileSync(transcriptPath, '{"type":"assistant"}\n');
    const adapter = new ClaudeCliAdapter({
      workingDirectory: cwd,
      sessionId: 'session-live',
      env: { CLAUDE_CONFIG_DIR: root },
    });
    const outputs: OutputMessage[] = [];
    adapter.on('output', (message: OutputMessage) => outputs.push(message));
    const ingress = adapter as unknown as Ingress;
    feedTaskFrames(ingress, 'a1', 'toolu-1');
    ingress.handleExit(null, 'SIGKILL');
    const records = stoppedHelpersOf(outputs[0]!) as Array<Record<string, unknown>>;
    expect(records[0]!['agentId']).toBe('a1');
    expect(records[0]!['sessionId']).toBe('session-live');
    expect(records[0]!['transcriptPath']).toBe(transcriptPath);
  });

  it('excludes helpers that already finished', () => {
    const adapter = new ClaudeCliAdapter();
    const outputs: OutputMessage[] = [];
    adapter.on('output', (message: OutputMessage) => outputs.push(message));
    const ingress = adapter as unknown as Ingress;
    feedTaskFrames(ingress, 'agent-done', 'toolu-done');
    finishTask(ingress, 'agent-done', 'toolu-done');
    feedTaskFrames(ingress, 'agent-live', 'toolu-live');
    ingress.handleExit(null, 'SIGKILL');
    const records = stoppedHelpersOf(outputs[0]!) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]!['toolUseId']).toBe('toolu-live');
  });

  it('delivers the notice to the termination reporter instead of output', () => {
    const adapter = new ClaudeCliAdapter();
    const outputs: OutputMessage[] = [];
    const reported: OutputMessage[] = [];
    adapter.on('output', (message: OutputMessage) => outputs.push(message));
    adapter.setBackgroundWorkTerminationReporter((message) => {
      reported.push(message);
    });
    const ingress = adapter as unknown as Ingress;
    feedTaskFrames(ingress, 'agent-1', 'toolu-1');
    ingress.handleExit(null, 'SIGKILL');
    expect(reported).toHaveLength(1);
    expect(stoppedHelpersOf(reported[0]!)).toHaveLength(1);
    expect(outputs.filter((message) => stoppedHelpersOf(message) !== undefined)).toHaveLength(0);
  });

  it('stays silent when every helper already finished or none ran', () => {
    const adapter = new ClaudeCliAdapter();
    const outputs: OutputMessage[] = [];
    adapter.on('output', (message: OutputMessage) => outputs.push(message));
    const ingress = adapter as unknown as Ingress;
    ingress.handleExit(null, 'SIGKILL');
    expect(outputs).toHaveLength(0);
    feedTaskFrames(ingress, 'agent-done', 'toolu-done');
    finishTask(ingress, 'agent-done', 'toolu-done');
    ingress.handleExit(null, 'SIGKILL');
    expect(outputs).toHaveLength(0);
  });

  it('reports a live helper once even if the stop is reported twice', () => {
    const adapter = new ClaudeCliAdapter();
    const outputs: OutputMessage[] = [];
    adapter.on('output', (message: OutputMessage) => outputs.push(message));
    const ingress = adapter as unknown as Ingress;
    feedTaskFrames(ingress, 'agent-1', 'toolu-1');
    ingress.reportStoppedHelpers();
    ingress.reportStoppedHelpers();
    ingress.handleExit(null, 'SIGKILL');
    expect(outputs.filter((message) => stoppedHelpersOf(message) !== undefined)).toHaveLength(1);
  });
});
