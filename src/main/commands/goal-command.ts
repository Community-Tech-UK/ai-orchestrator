import type { Instance } from '../../shared/types/instance.types';

const GOAL_METADATA_KEY = 'goal';
export type InstanceGoalStatus = 'active' | 'paused';

export interface InstanceGoalState {
  objective: string;
  status: InstanceGoalStatus;
  createdAt: number;
  updatedAt: number;
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
