/** A remote Codex chat must not start on a worker that would silently drop the controller's helper setting. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const nodes = vi.hoisted(() => ({ capabilities: {} as Record<string, unknown> }));
const registry = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => settings.value }) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry.value }));
vi.mock('../../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));

import { RemoteCliAdapter } from './remote-cli-adapter';
import { REMOTE_CODEX_EXEC_SKILLS_POLICY_UNSUPPORTED, REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED } from './remote-codex-helper-policy';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import type { UnifiedSpawnOptions } from './adapter-factory';

function makeAdapter(sendRpc: ReturnType<typeof vi.fn>, extra: Partial<UnifiedSpawnOptions> = {}): RemoteCliAdapter {
  const connection = { sendRpc, isNodeConnected: vi.fn(() => true) } as unknown as WorkerNodeConnectionServer;
  const options = { sessionId: 'inst-1', workingDirectory: '/repo', sessionKind: 'chat', trialArm: 'cheaper', trialKey: 'chat-1', ...extra } as unknown as UnifiedSpawnOptions;
  return new RemoteCliAdapter(connection, 'windows-pc', 'codex', options);
}

describe('RemoteCliAdapter Codex helper policy capability', () => {
  beforeEach(() => {
    const emitter = new EventEmitter() as EventEmitter & { getNode: () => unknown };
    emitter.getNode = () => ({ capabilities: nodes.capabilities });
    registry.value = emitter;
  });

  it('refuses a legacy worker before any spawn RPC when the clean-helper level would be dropped', async () => {
    settings.value = { codexHelperAgentsChats: 'trial' }; // trial arm 'cheaper' resolves to economy
    nodes.capabilities = {};
    const sendRpc = vi.fn();
    await expect(makeAdapter(sendRpc).spawn()).rejects.toThrow(REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED);
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('starts on a worker that advertises the capability, sending the resolved level', async () => {
    settings.value = { codexHelperAgentsChats: 'trial' };
    nodes.capabilities = { codexHelperPolicy: 1 };
    const sendRpc = vi.fn().mockResolvedValue({ instanceId: 'inst-1' });
    await makeAdapter(sendRpc).spawn();
    expect(sendRpc).toHaveBeenCalledWith('windows-pc', 'instance.spawn', expect.objectContaining({ codexHelperLevel: 'economy' }));
  });

  it('refuses a legacy worker for a full-level session too, since its per-turn helper share would not be recorded', async () => {
    settings.value = { codexHelperAgentsChats: 'full' };
    nodes.capabilities = {};
    const sendRpc = vi.fn();
    await expect(makeAdapter(sendRpc).spawn()).rejects.toThrow(REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED);
    expect(sendRpc).not.toHaveBeenCalled();
  });

  describe('command-mode skills policy', () => {
    const checker = { sessionKind: 'plan-queue', queueRole: 'verifier' } as Partial<UnifiedSpawnOptions>;

    it('refuses a worker built before the skills policy for a plan-queue checker, before any spawn RPC', async () => {
      settings.value = { codexHelperAgentsHarnessWork: 'full' };
      nodes.capabilities = { codexSpawnMetadata: 1, codexHelperPolicy: 1 };
      const sendRpc = vi.fn();
      await expect(makeAdapter(sendRpc, checker).spawn()).rejects.toThrow(REMOTE_CODEX_EXEC_SKILLS_POLICY_UNSUPPORTED);
      expect(sendRpc).not.toHaveBeenCalled();
    });

    it('starts the checker on a worker that advertises the skills policy, sending the checker catalog choice', async () => {
      settings.value = { codexHelperAgentsHarnessWork: 'full', codexCheckerSkillCatalog: 'omit' };
      nodes.capabilities = { codexSpawnMetadata: 1, codexHelperPolicy: 1, codexExecSkillsPolicy: 1 };
      const sendRpc = vi.fn().mockResolvedValue({ instanceId: 'inst-1' });
      await makeAdapter(sendRpc, checker).spawn();
      expect(sendRpc).toHaveBeenCalledWith('windows-pc', 'instance.spawn', expect.objectContaining({ sessionKind: 'plan-queue', codexOmitSkillCatalog: true }));
    });

    it('still starts a chat on a worker built before the skills policy', async () => {
      settings.value = { codexHelperAgentsChats: 'full' };
      nodes.capabilities = { codexSpawnMetadata: 1, codexHelperPolicy: 1 };
      const sendRpc = vi.fn().mockResolvedValue({ instanceId: 'inst-1' });
      await makeAdapter(sendRpc).spawn();
      expect(sendRpc).toHaveBeenCalledTimes(1);
    });
  });
});
