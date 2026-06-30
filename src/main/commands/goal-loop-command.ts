import type { IpcResponse } from '../../shared/types/ipc.types';
import type { ParsedCommand } from '../../shared/types/command.types';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { LoopProvider, LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { isActiveLoopRuntimeState } from '../orchestration/loop-runtime-status';
import { getLoopStore } from '../orchestration/loop-store';
import { prepareLoopStartConfig } from '../orchestration/loop-start-config';
import {
  buildGoalLoopStartConfig,
  parseGoalCommandArgs,
  type GoalCommandAction,
} from '../orchestration/goal-command-loop';
import { buildExistingSessionContext } from '../orchestration/loop-existing-session-context';
import { getChatService } from '../chats';
import { appendLoopStartPrompt } from '../ipc/handlers/loop-transcript-dispatch';

const logger = getLogger('GoalLoopCommand');

export async function executeGoalLoopCommand(input: {
  instanceManager: InstanceManager;
  instanceId: string;
  workingDirectory: string | undefined;
  provider: string | undefined;
  executed: ParsedCommand;
}): Promise<IpcResponse> {
  const action = parseGoalCommandArgs(input.executed.args);
  if (action.type === 'invalid') {
    return commandError('GOAL_INVALID', action.reason);
  }

  if (action.type !== 'start') {
    return executeGoalControl(input, action);
  }

  if (!input.workingDirectory) {
    return commandError('GOAL_REQUIRES_WORKSPACE', 'Goal mode requires a working directory.');
  }
  const provider = asLoopProvider(input.provider);
  if (!provider) {
    return commandError('GOAL_PROVIDER_UNSUPPORTED', 'Goal mode is not available for this provider.');
  }

  const coordinator = getLoopCoordinator();
  const store = getLoopStore();
  const chatService = getChatService({ instanceManager: input.instanceManager });
  const rawConfig = buildGoalLoopStartConfig({
    objective: action.objective,
    workspaceCwd: input.workingDirectory,
    provider,
  });
  const config = await prepareLoopStartConfig(rawConfig);
  const state = await coordinator.startLoop(
    input.instanceId,
    config,
    undefined,
    {
      existingSessionContext: buildExistingSessionContext(
        input.instanceManager,
        input.instanceId,
      ),
    },
  );

  try {
    store.upsertRun(state);
  } catch (error) {
    logger.warn('/goal initial upsertRun failed', { error: String(error) });
  }
  try {
    appendLoopStartPrompt(state, chatService, input.instanceManager);
  } catch (error) {
    logger.warn('/goal failed to append loop start prompt', {
      loopRunId: state.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    success: true,
    data: {
      ...input.executed,
      goal: { action: 'started', loopRunId: state.id },
    },
  };
}

export async function executeGoalLoopCommandForInstanceInput(input: {
  instanceManager: InstanceManager;
  instanceId: string;
  instance: Pick<Instance, 'workingDirectory' | 'provider'>;
  executed: ParsedCommand | null;
}): Promise<void> {
  if (!input.executed) {
    input.instanceManager.emitSystemMessage(input.instanceId, 'Unable to resolve /goal command.', {
      source: 'goal-command',
      action: 'error',
    });
    return;
  }

  const result = await executeGoalLoopCommand({
    instanceManager: input.instanceManager,
    instanceId: input.instanceId,
    workingDirectory: input.instance.workingDirectory,
    provider: input.instance.provider,
    executed: input.executed,
  });
  if (!result.success) {
    input.instanceManager.emitSystemMessage(
      input.instanceId,
      result.error?.message ?? 'Goal command failed.',
      {
        source: 'goal-command',
        action: 'error',
        code: result.error?.code,
      },
    );
  }
}

async function executeGoalControl(input: {
  instanceManager: InstanceManager;
  instanceId: string;
  executed: ParsedCommand;
}, action: Exclude<GoalCommandAction, { type: 'start' | 'invalid' }>): Promise<IpcResponse> {
  const coordinator = getLoopCoordinator();
  const store = getLoopStore();
  const active = coordinator.getActiveLoops()
    .filter((state) => state.chatId === input.instanceId && isActiveLoopRuntimeState(state))
    .sort((a, b) => b.startedAt - a.startedAt)[0];

  if (action.type === 'status') {
    const message = active
      ? `Goal loop ${active.id} is ${active.status} after ${active.totalIterations} iteration(s).`
      : 'No active goal loop is set for this session.';
    emitGoalSystemMessage(input.instanceManager, input.instanceId, message, action.type, active);
    return {
      success: true,
      data: { ...input.executed, goal: { action: 'status', loopRunId: active?.id ?? null } },
    };
  }

  if (!active) {
    const message = `No active goal loop is available to ${action.type}.`;
    emitGoalSystemMessage(input.instanceManager, input.instanceId, message, action.type, null);
    return {
      success: true,
      data: { ...input.executed, goal: { action: action.type, loopRunId: null, ok: false } },
    };
  }

  let ok = false;
  if (action.type === 'pause') {
    ok = coordinator.pauseLoop(active.id);
  } else if (action.type === 'resume') {
    ok = coordinator.resumeLoop(active.id);
  } else {
    ok = await coordinator.cancelLoop(active.id);
  }

  const state = coordinator.getLoop(active.id);
  if (state) {
    persistGoalControlState(store, state);
  }
  const verb = action.type === 'clear' ? 'cleared' : `${action.type}d`;
  emitGoalSystemMessage(
    input.instanceManager,
    input.instanceId,
    ok ? `Goal loop ${active.id} ${verb}.` : `Goal loop ${active.id} could not be ${verb}.`,
    action.type,
    state ?? active,
  );
  return {
    success: true,
    data: { ...input.executed, goal: { action: action.type, loopRunId: active.id, ok } },
  };
}

function persistGoalControlState(store: ReturnType<typeof getLoopStore>, state: LoopState): void {
  try {
    store.upsertRun(state);
  } catch (error) {
    logger.warn('/goal control upsertRun failed', { loopRunId: state.id, error: String(error) });
  }
}

function emitGoalSystemMessage(
  instanceManager: InstanceManager,
  instanceId: string,
  content: string,
  action: string,
  state: LoopState | null | undefined,
): void {
  instanceManager.emitSystemMessage(instanceId, content, {
    source: 'goal-command',
    action,
    loopRunId: state?.id,
    status: state?.status ?? 'none',
  });
}

function asLoopProvider(provider: string | undefined): LoopProvider | undefined {
  if (
    provider === 'claude'
    || provider === 'codex'
    || provider === 'gemini'
    || provider === 'antigravity'
    || provider === 'copilot'
    || provider === 'cursor'
  ) {
    return provider;
  }
  return undefined;
}

function commandError(code: string, message: string): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message,
      timestamp: Date.now(),
    },
  };
}
