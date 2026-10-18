import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopConfig, LoopState } from '../../shared/types/loop.types';
import type { ParsedCommand } from '../../shared/types/command.types';
import type { InstanceManager } from '../instance/instance-manager';

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mocks = vi.hoisted(() => ({ start: vi.fn(), resolve: vi.fn(), defaultCli: 'codex' }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({ startLoop: mocks.start }) }));
vi.mock('../orchestration/loop-store', () => ({ getLoopStore: () => ({ upsertRun: vi.fn() }) }));

vi.mock('../orchestration/loop-existing-session-context', () => ({ buildExistingSessionContext: () => undefined }));
vi.mock('../chats', () => ({ getChatService: () => ({}) }));
vi.mock('../ipc/handlers/loop-transcript-dispatch', () => ({ appendLoopStartPrompt: vi.fn() }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: mocks.resolve }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ defaultCli: mocks.defaultCli }) }) }));
import { executeGoalLoopCommand, executeGoalLoopCommandForInstanceInput } from './goal-loop-command';

const executed: ParsedCommand = {
  command: { id: 'goal', name: 'goal', description: 'Goal', template: '', builtIn: true, createdAt: 1, updatedAt: 1 },
  args: ['Finish the checks'], execution: { type: 'goal' }, resolvedPrompt: '',
};
const run = (provider: string | undefined) => executeGoalLoopCommand({
  instanceManager: { emitSystemMessage: vi.fn() } as unknown as InstanceManager, instanceId: 'instance-1', workingDirectory: '/test/workspace', provider, executed,
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.defaultCli = 'codex';
  mocks.start.mockImplementation(async (_instance: string, config: LoopConfig) => ({ id: 'loop-1', config }) as unknown as LoopState);
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

describe('goal start through real preparation', () => {
  let workspace: string;
  const manager = { getInstance: vi.fn(), emitSystemMessage: vi.fn() };
  const executedBuiltin: ParsedCommand = {
    command: { id: 'builtin-goal', name: 'goal', description: '', template: '', builtIn: true, createdAt: 0, updatedAt: 0 },
    execution: { type: 'goal' }, args: ['Fix', 'the', 'widget'], resolvedPrompt: '',
  };
  beforeEach(() => {
    vi.clearAllMocks();
    workspace = mkdtempSync(join(tmpdir(), 'goal-start-'));
    mocks.start.mockImplementation(async (_chatId: string, config: LoopConfig) => ({ id: 'loop-1', chatId: 'session-1', config } as unknown as LoopState));
    mocks.resolve.mockResolvedValue('claude');
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));
  const input = () => ({ instanceManager: manager as unknown as InstanceManager, instanceId: 'session-1', workingDirectory: workspace, provider: 'claude', executed: executedBuiltin });

  it('starts a /goal loop with no usage cap through real prepareLoopStartConfig', async () => {
    const result = await executeGoalLoopCommand(input());
    expect(result.success).toBe(true);
    expect(mocks.start.mock.calls[0][1].caps.maxCostCents).toBeNull();
    expect(mocks.start.mock.calls[0][1].completion.allowOperatorReviewedCompletion).toBe(true);
  });

  it('returns GOAL_START_FAILED instead of throwing', async () => {
    mocks.start.mockRejectedValue(new Error('Cannot start this loop'));
    expect(await executeGoalLoopCommand(input())).toMatchObject({ success: false, error: { code: 'GOAL_START_FAILED', message: 'Cannot start this loop' } });
  });

  it('emits a goal-command system message on a refused start', async () => {
    mocks.start.mockRejectedValue(new Error('Cannot start this loop'));
    await executeGoalLoopCommandForInstanceInput({ ...input(), instance: { workingDirectory: workspace, provider: 'claude' } });
    expect(manager.emitSystemMessage).toHaveBeenCalledWith('session-1', 'Cannot start this loop', expect.objectContaining({ source: 'goal-command', action: 'error', code: 'GOAL_START_FAILED' }));
  });
});
