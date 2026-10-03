import { describe, expect, it } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import { getLogManager } from '../../logging/logger';

describe('ACP task and byte liveness integration', () => {
  it('logs the armed inactivity lease rather than a blind delegated ceiling', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath, workingDirectory: '/tmp', promptTimeoutMs: 5000,
      activeToolTimeoutMs: 10000, delegatedTaskTimeoutMs: 40000,
    });
    proc.onRequest('session/prompt', (request) => {
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
        sessionUpdate: 'tool_call', toolCallId: 'task', title: 'task', kind: 'think', status: 'in_progress',
        rawInput: { prompt: 'Review', description: 'Gate' },
      } });
      proc.respond(request.id, { stopReason: 'end_turn' });
    });
    await adapter.spawn();
    try {
      await adapter.sendMessage({ role: 'user', content: 'fixture' });
      const log = getLogManager().getRecentLogs({ subsystem: 'AcpCliAdapter', limit: 20 })
        .find((entry) => entry.message === 'ACP turn completed');
      expect(log?.data?.['leaseMs']).toBeLessThanOrEqual(10000);
      expect(log?.data?.['leaseMs']).toBeGreaterThan(0);
    } finally { proc.exit(); }
  });

  it('keeps a silent parent alive for exact native child work created before delayed ACP observation', async () => {
    const proc = createInitializedAgentHarness();
    const childCreatedAt = Date.now() - 25;
    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath, workingDirectory: '/tmp', promptTimeoutMs: 50,
      activeToolTimeoutMs: 80, delegatedTaskTimeoutMs: 500,
      childProgressSource: {
        start: (_, progress) => {
          const interval = setInterval(() => progress({ sessionId: 'child', title: 'Gate (@agent subagent)', createdAt: childCreatedAt, toolCallId: 'task' }), 25);
          return () => clearInterval(interval);
        },
      },
    });
    proc.onRequest('session/prompt', (request) => {
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
        sessionUpdate: 'tool_call', toolCallId: 'task', title: 'task', kind: 'think', status: 'in_progress',
        rawInput: { description: 'Gate', prompt: 'Review' },
      } });
      setTimeout(() => proc.respond(request.id, { stopReason: 'end_turn' }), 170);
    });
    await adapter.spawn();
    await expect(adapter.sendMessage({ role: 'user', content: 'review' })).resolves.toHaveProperty('metadata.stopReason', 'end_turn');
    proc.exit();
  });

  it('partial raw stdout refreshes the prompt RPC before a complete notification exists', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { command: process.execPath, workingDirectory: '/tmp', promptTimeoutMs: 70 });
    proc.onRequest('session/prompt', (request) => {
      const interval = setInterval(() => proc.stdout.write(' '), 25);
      setTimeout(() => {
        clearInterval(interval);
        proc.stdout.write('\n');
        proc.respond(request.id, { stopReason: 'end_turn' });
      }, 150);
    });
    await adapter.spawn();
    await expect(adapter.sendMessage({ role: 'user', content: 'run' })).resolves.toHaveProperty('metadata.stopReason', 'end_turn');
    proc.exit();
  });

  it('reports observed pipe blockage once without exposing the raw diagnostic', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { command: process.execPath, workingDirectory: '/tmp' });
    const notices: string[] = [];
    adapter.on('output', (message) => { if (message.metadata?.source === 'acp-output-blocked') notices.push(message.content); });
    proc.onRequest('session/prompt', (request) => {
      proc.stderr.write('ACP connection write failed: Resource temporarily unavailable (os error 35)\n');
      proc.stderr.write('ACP connection write failed: Resource temporarily unavailable (os error 35)\n');
      proc.respond(request.id, { stopReason: 'end_turn' });
    });
    await adapter.spawn();
    await adapter.sendMessage({ role: 'user', content: 'run' });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Provider output is blocked');
    expect(notices[0]).not.toContain('os error');
    proc.exit();
  });
});
