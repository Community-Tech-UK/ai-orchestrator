import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopProviderSchema } from '@contracts/schemas/loop';
import type { LoopConfig, LoopState } from '../../shared/types/loop.types';
import type { ParsedCommand } from '../../shared/types/command.types';
import type { InstanceManager } from '../instance/instance-manager';

const mocks = vi.hoisted(() => ({ start: vi.fn(), prepare: vi.fn(), resolve: vi.fn(), defaultCli: 'codex' }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({ startLoop: mocks.start }) }));
vi.mock('../orchestration/loop-store', () => ({ getLoopStore: () => ({ upsertRun: vi.fn() }) }));
// This file verifies only Phase 2 provider resolution. Phase 0's uncapped /goal start guard is still absent.
vi.mock('../orchestration/loop-start-config', () => ({ prepareLoopStartConfig: mocks.prepare, markInteractiveLoopStart: (config: LoopConfig) => ({ ...config, onFailedStep: 'pause' }) }));
vi.mock('../orchestration/loop-existing-session-context', () => ({ buildExistingSessionContext: () => undefined }));
vi.mock('../chats', () => ({ getChatService: () => ({}) }));
vi.mock('../ipc/handlers/loop-transcript-dispatch', () => ({ appendLoopStartPrompt: vi.fn() }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: mocks.resolve }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ defaultCli: mocks.defaultCli }) }) }));
import { executeGoalLoopCommand } from './goal-loop-command';

const executed: ParsedCommand = {
  command: { id: 'goal', name: 'goal', description: 'Goal', template: '', builtIn: true, createdAt: 1, updatedAt: 1 },
  args: ['Finish the checks'], execution: { type: 'goal' }, resolvedPrompt: '',
};
const run = (provider: string | undefined) => executeGoalLoopCommand({
  instanceManager: { emitSystemMessage: vi.fn() } as unknown as InstanceManager, instanceId: 'instance-1', workingDirectory: '/test/workspace', provider, executed,
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.defaultCli = 'codex';
  mocks.prepare.mockImplementation(async (config: LoopConfig) => config);
  mocks.start.mockImplementation(async (_instance: string, config: LoopConfig) => ({ id: 'loop-1', config }) as LoopState);
  mocks.resolve.mockResolvedValue('codex');
});

describe('/goal provider guard', () => {
  it.each(LoopProviderSchema.options)('passes %s sessions to the loop engine', async (provider) => {
    expect(await run(provider)).toMatchObject({ success: true });
    expect(mocks.start.mock.calls[0][1]).toMatchObject({ provider });
  });

  it('resolves auto sessions through the default CLI', async () => {
    expect(await run('auto')).toMatchObject({ success: true });
    expect(mocks.start.mock.calls[0][1].provider).toBe('codex');
    expect(mocks.resolve).toHaveBeenCalledWith('auto', 'codex');
  });

  it('names an unsupported provider in the refusal', async () => {
    expect(await run('ollama')).toMatchObject({ success: false, error: { code: 'GOAL_PROVIDER_UNSUPPORTED', message: expect.stringContaining('ollama') } });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('refuses an unresolvable auto provider without throwing', async () => {
    mocks.resolve.mockRejectedValue(new Error('No CLI available'));
    expect(await run('auto')).toMatchObject({ success: false, error: { code: 'GOAL_PROVIDER_UNSUPPORTED', message: expect.stringContaining('auto') } });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
