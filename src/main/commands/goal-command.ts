import type { Instance } from '../../shared/types/instance.types';

const GOAL_METADATA_KEY = 'goal';
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

export type GoalCommandAction = 'set' | 'view' | 'pause' | 'resume' | 'clear';
export type InstanceGoalStatus = 'active' | 'paused';

export interface InstanceGoalState {
  objective: string;
  status: InstanceGoalStatus;
  createdAt: number;
  updatedAt: number;
}

export interface GoalCommandResult {
  action: GoalCommandAction;
  notice: string;
  providerPrompt: string | null;
  state: InstanceGoalState | null;
}

export interface GoalCommandOptions {
  now?: number;
}

export function applyGoalCommand(
  instance: Instance,
  args: readonly string[],
  options: GoalCommandOptions = {},
): GoalCommandResult {
  const now = options.now ?? Date.now();
  const control = args.length === 1 ? args[0]?.toLowerCase() : undefined;

  if (!control && args.length === 0) {
    return viewGoal(instance);
  }

  if (control === 'pause') {
    return pauseGoal(instance, now);
  }

  if (control === 'resume') {
    return resumeGoal(instance, now);
  }

  if (control === 'clear') {
    return clearGoal(instance);
  }

  return setGoal(instance, args.join(' ').trim(), now);
}

export function getInstanceGoalState(instance: Pick<Instance, 'metadata'>): InstanceGoalState | null {
  return parseGoalState(instance.metadata?.[GOAL_METADATA_KEY]);
}

export function buildActiveGoalContext(instance: Pick<Instance, 'metadata'>): string | null {
  const state = getInstanceGoalState(instance);
  if (!state || state.status !== 'active') {
    return null;
  }

  return [
    '## Active /goal',
    '',
    'Objective:',
    state.objective,
    '',
    'Treat this as the active completion condition across turns. Keep working toward it unless the user changes, pauses, or clears the goal. When the objective is satisfied, say what evidence satisfies it. If it is blocked, state the concrete blocker.',
  ].join('\n');
}

export function appendActiveGoalContext(
  contextBlock: string | null,
  instance: Pick<Instance, 'metadata'>,
): string | null {
  const goalContext = buildActiveGoalContext(instance);
  return goalContext ? [contextBlock, goalContext].filter(Boolean).join('\n\n') : contextBlock;
}

function viewGoal(instance: Instance): GoalCommandResult {
  const state = getInstanceGoalState(instance);
  if (!state) {
    return {
      action: 'view',
      notice: 'No active goal is set.',
      providerPrompt: null,
      state: null,
    };
  }

  return {
    action: 'view',
    notice: `Goal (${state.status}): ${state.objective}`,
    providerPrompt: null,
    state,
  };
}

function setGoal(instance: Instance, objective: string, now: number): GoalCommandResult {
  if (!objective) {
    return viewGoal(instance);
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    throw new Error(`Goal text must be ${MAX_GOAL_OBJECTIVE_LENGTH} characters or fewer`);
  }

  const previous = getInstanceGoalState(instance);
  const state: InstanceGoalState = {
    objective,
    status: 'active',
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  setInstanceGoalState(instance, state);

  return {
    action: 'set',
    notice: `Active goal set: ${objective}`,
    providerPrompt: buildSetProviderPrompt(objective),
    state,
  };
}

function pauseGoal(instance: Instance, now: number): GoalCommandResult {
  const current = getInstanceGoalState(instance);
  if (!current) {
    return {
      action: 'pause',
      notice: 'No active goal is set to pause.',
      providerPrompt: null,
      state: null,
    };
  }

  const state: InstanceGoalState = {
    ...current,
    status: 'paused',
    updatedAt: now,
  };
  setInstanceGoalState(instance, state);

  return {
    action: 'pause',
    notice: `Goal paused: ${state.objective}`,
    providerPrompt: 'Pause the active completion goal. Do not continue autonomously toward it until a resume request is received.',
    state,
  };
}

function resumeGoal(instance: Instance, now: number): GoalCommandResult {
  const current = getInstanceGoalState(instance);
  if (!current) {
    return {
      action: 'resume',
      notice: 'No active goal is set to resume.',
      providerPrompt: null,
      state: null,
    };
  }

  const state: InstanceGoalState = {
    ...current,
    status: 'active',
    updatedAt: now,
  };
  setInstanceGoalState(instance, state);

  return {
    action: 'resume',
    notice: `Goal resumed: ${state.objective}`,
    providerPrompt: buildSetProviderPrompt(state.objective),
    state,
  };
}

function clearGoal(instance: Instance): GoalCommandResult {
  const current = getInstanceGoalState(instance);
  setInstanceGoalState(instance, null);

  return {
    action: 'clear',
    notice: current
      ? `Goal cleared: ${current.objective}`
      : 'No active goal is set to clear.',
    providerPrompt: current
      ? 'Clear the active completion goal. Stop treating previous goal instructions as active unless the user sets a new goal.'
      : null,
    state: null,
  };
}

function buildSetProviderPrompt(objective: string): string {
  return [
    'Active goal control from AI Orchestrator.',
    '',
    'Active goal:',
    objective,
    '',
    'Use this as the completion condition across future turns. Work toward it now, continue until it is satisfied, and report completion with concrete evidence. If the goal cannot be completed, state the blocker and what would unblock it.',
  ].join('\n');
}

function setInstanceGoalState(instance: Instance, state: InstanceGoalState | null): void {
  const metadata = { ...(instance.metadata ?? {}) };
  if (state) {
    metadata[GOAL_METADATA_KEY] = state;
  } else {
    delete metadata[GOAL_METADATA_KEY];
  }
  instance.metadata = metadata;
}

function parseGoalState(value: unknown): InstanceGoalState | null {
  if (!isRecord(value)) {
    return null;
  }

  const objective = value['objective'];
  const status = value['status'];
  const createdAt = value['createdAt'];
  const updatedAt = value['updatedAt'];

  if (
    typeof objective !== 'string' ||
    objective.length === 0 ||
    (status !== 'active' && status !== 'paused') ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    return null;
  }

  return {
    objective,
    status,
    createdAt,
    updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
