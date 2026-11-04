import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCopilotAdapter } from '../adapter-factory';
import { createInitializedAgentHarness } from '../acp-cli-adapter.test-helpers';
import type { ContextUsage } from '../../../../shared/types/instance.types';
import { CopilotCliAdapter, resetCopilotModelDiscoveryCache } from '../copilot-cli-adapter';
import { CopilotEventsTail } from './copilot-events-tail';

vi.mock('./copilot-sdk-loader', () => ({ loadCopilotSdk: () => null }));

const roots: string[] = [];
const originalHome = process.env['AI_ORCHESTRATOR_COPILOT_HOME'];
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env['AI_ORCHESTRATOR_COPILOT_HOME'];
  else process.env['AI_ORCHESTRATOR_COPILOT_HOME'] = originalHome;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(id: string) {
  const home = await mkdtemp(join(process.cwd(), '_scratch', 'step11-adapter-')); roots.push(home);
  process.env['AI_ORCHESTRATOR_COPILOT_HOME'] = home;
  await mkdir(join(home, 'session-state', id), { recursive: true });
  await writeFile(join(home, 'session-state', id, 'events.jsonl'),
    JSON.stringify({ type: 'session.shutdown', data: { totalPremiumRequests: 15 } }) + '\n');
  return home;
}
describe('Copilot production adapter usage wiring', () => {
  it('does not start a usage tail for version/help probes or a failed ACP startup', async () => {
    await fixture('sess-acp-1');
    const poll = vi.spyOn(CopilotEventsTail.prototype, 'poll');
    const probe = new CopilotCliAdapter();
    vi.spyOn(probe as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockImplementation(args => {
      const proc = createInitializedAgentHarness();
      queueMicrotask(() => {
        proc.stdout.write(args.includes('--version') ? '1.0.103\n' : '`model`: AI model to use for Copilot CLI\n - "auto"\n');
        proc.exit();
      });
      return proc as unknown as ChildProcess;
    });
    resetCopilotModelDiscoveryCache();
    expect((await probe.checkStatus()).available).toBe(true);
    expect((await probe.listAvailableModels()).some(model => model.id === 'auto')).toBe(true);
    await probe.terminate(false);
    const adapter = createCopilotAdapter({ workingDirectory: tmpdir(), copilotAccountRoute: {
      profileId: 'legacy', source: 'legacy', executionNodeId: 'local', profileLabel: 'Test account', expectedLogin: 'placeholder', host: 'github.com',
    } });
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/new', message => proc.respondError(message.id, -32603, 'Synthetic startup failure'));
    vi.spyOn(adapter, 'checkStatus').mockResolvedValue({ available: true });
    vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockReturnValue(proc as unknown as ChildProcess);
    (adapter as unknown as { acpConfig: { prepareSpawn?: unknown } }).acpConfig.prepareSpawn = undefined;
    try { await expect(adapter.spawn()).rejects.toThrow('Synthetic startup failure'); }
    finally { proc.exit(); await adapter.terminate(false); }
    expect(poll).not.toHaveBeenCalled();
  });
  it('attaches the routed ACP factory to its actual session and clears the poller on termination', async () => {
    await fixture('sess-acp-1');
    const adapter = createCopilotAdapter({ workingDirectory: tmpdir(), copilotAccountRoute: {
      profileId: 'legacy', source: 'legacy', executionNodeId: 'local', profileLabel: 'Test account', expectedLogin: 'placeholder', host: 'github.com',
    } });
    const proc = createInitializedAgentHarness();
    const contexts: ContextUsage[] = [];
    adapter.on('context', value => contexts.push(value));
    vi.spyOn(adapter, 'checkStatus').mockResolvedValue({ available: true });
    vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockReturnValue(proc as unknown as ChildProcess);
    // Avoid the external --help probe; this test exercises ACP handshake and session wiring.
    (adapter as unknown as { acpConfig: { prepareSpawn?: unknown } }).acpConfig.prepareSpawn = undefined;
    try {
      await adapter.spawn();
      expect(contexts.at(-1)?.copilotUsage?.premiumRequests).toBe(15);
      expect(contexts.at(-1)?.occupancyReported).not.toBe(true);
    } finally { proc.exit(); await adapter.terminate(false); }
  });

  it('reads the native exec result session rather than the synthetic owning adapter ID', async () => {
    await fixture('native-session');
    const proc = createInitializedAgentHarness();
    const adapter = new CopilotCliAdapter({ accountProfileId: 'legacy' });
    vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockReturnValue(proc as unknown as ChildProcess);
    const contexts: ContextUsage[] = [];
    adapter.on('context', value => contexts.push(value));
    const turn = adapter.sendMessage({ role: 'user', content: 'Synthetic test prompt' });
    proc.stdout.write(JSON.stringify({ type: 'result', sessionId: 'native-session', usage: {} }) + '\n');
    proc.exit();
    await turn;
    expect(contexts.at(-1)?.copilotUsage?.premiumRequests).toBe(15);
    await adapter.terminate(false);
  });

  it('does not complete a terminated native turn when its final file read resolves late', async () => {
    await fixture('native-session');
    let release!: (value: { compactions: number; premiumRequests: number }) => void;
    const read = new Promise<{ compactions: number; premiumRequests: number }>(resolve => { release = resolve; });
    vi.spyOn(CopilotEventsTail.prototype, 'poll').mockReturnValue(read);
    const proc = createInitializedAgentHarness();
    const adapter = new CopilotCliAdapter({ accountProfileId: 'legacy' });
    vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockReturnValue(proc as unknown as ChildProcess);
    const completed: unknown[] = [];
    adapter.on('complete', value => completed.push(value));
    const turn = adapter.sendMessage({ role: 'user', content: 'Synthetic prompt' });
    const rejected = expect(turn).rejects.toThrow(/terminated|cancelled|changed/);
    proc.stdout.write(JSON.stringify({ type: 'result', sessionId: 'native-session', usage: {} }) + '\n');
    proc.exit();
    await adapter.terminate(false);
    release({ compactions: 0, premiumRequests: 15 });
    await rejected;
    expect(completed).toEqual([]);
  });
});
