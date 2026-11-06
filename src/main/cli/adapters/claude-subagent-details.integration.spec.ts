import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliAdapter } from './claude-cli-adapter';

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aio-subagent-adapter-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Claude helper details through the real adapter stream path', () => {
  it('reports the helper model from its own frames and its start details from its meta file', () => {
    const cwd = '/example/project';
    const dir = join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'session-9', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-helper1.meta.json'), JSON.stringify({
      agentType: 'general-purpose', description: 'never stored', requestShape: 'background', spawnDepth: 1, isFork: false, model: 'sonnet',
    }));
    const adapter = new ClaudeCliAdapter({ workingDirectory: cwd, model: 'opus', env: { CLAUDE_CONFIG_DIR: root } });
    const samples = vi.fn();
    adapter.on('subagent_usage', samples);
    const ingress = adapter as unknown as { processCliMessage(message: unknown): void };

    ingress.processCliMessage({ type: 'system', subtype: 'init', session_id: 'session-9' });
    ingress.processCliMessage({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'helper1', tool_use_id: 'toolu_a', session_id: 'session-9' });
    ingress.processCliMessage({ type: 'assistant', parent_tool_use_id: 'toolu_a', message: { model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 12_000, output_tokens: 5 } } });
    ingress.processCliMessage({ type: 'system', subtype: 'task_notification', task_id: 'helper1', usage: { total_tokens: 12_005, tool_uses: 3, duration_ms: 800 }, session_id: 'session-9' });

    const final = samples.mock.calls.map((call) => call[0]).find((sample) => sample.final);
    expect(final).toMatchObject({
      toolUseId: 'toolu_a', model: 'claude-sonnet-5-5', modelSource: 'stream',
      agentType: 'general-purpose', fork: false, depth: 1, mode: 'background', finalContextTokens: 12_005,
    });
    expect(JSON.stringify(final)).not.toContain('never stored');
    // The helper's 12K request must not stand in for the main thread's occupancy.
    expect(adapter.getLastContextUsage()).toEqual({ status: 'unknown', reason: 'not-reported' });
  });
});
