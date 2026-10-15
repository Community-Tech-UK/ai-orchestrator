import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopConfig, LoopState } from '../../shared/types/loop.types';
import type { ParsedCommand } from '../../shared/types/command.types';
import type { InstanceManager } from '../instance/instance-manager';

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mocks = vi.hoisted(() => ({ start: vi.fn(), prepare: vi.fn(), resolve: vi.fn(), defaultCli: 'codex' }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({ startLoop: mocks.start }) }));
vi.mock('../orchestration/loop-store', () => ({ getLoopStore: () => ({ upsertRun: vi.fn() }) }));

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

describe('/goal real start preparation', () => {
  it('starts uncapped sign-off and reports the reason to the session', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'goal-start-'));
    const emitSystemMessage = vi.fn();
    try {
      const result = await executeGoalLoopCommand({ instanceManager: { emitSystemMessage } as unknown as InstanceManager, instanceId: 'instance-1', workingDirectory: workspace, provider: 'codex', executed });
      expect(result).toMatchObject({ success: true, data: { goal: { completion: 'sign-off' } } });
      expect(mocks.start.mock.calls[0][1].completion.allowOperatorReviewedCompletion).toBe(true);
      expect(mocks.start.mock.calls[0][1].onFailedStep).toBe('pause');
      expect(emitSystemMessage).toHaveBeenCalledWith('instance-1', expect.stringContaining('no check command'), expect.objectContaining({ action: 'info' }));
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
  it('adopts folder checks through real preparation and reports autonomous completion', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'goal-start-'));
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { verify: 'echo verified' } }));
    try {
      const result = await executeGoalLoopCommand({ instanceManager: { emitSystemMessage: vi.fn() } as unknown as InstanceManager, instanceId: 'instance-1', workingDirectory: workspace, provider: 'codex', executed });
      expect(result).toMatchObject({ success: true, data: { goal: { completion: 'checks' } } });
      expect(mocks.start.mock.calls[0][1].completion).toMatchObject({ mode: 'review-driven', verifyCommand: 'npm run verify', allowOperatorReviewedCompletion: false });
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
  it('returns a visible refusal when loop start throws', async () => {
    mocks.start.mockRejectedValue(new Error('provider could not start'));
    expect(await run('codex')).toMatchObject({ success: false, error: { code: 'GOAL_START_FAILED', message: 'provider could not start' } });
  });
});
