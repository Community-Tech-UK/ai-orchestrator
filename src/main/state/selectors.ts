// src/main/state/selectors.ts
import type { AppState, InstanceSlice } from './app-state';
import type { InstanceStatus } from '../../shared/types/instance.types';

export function selectInstance(state: AppState, id: string): InstanceSlice | undefined {
  return state.instances[id];
}

export function selectAllInstances(state: AppState): InstanceSlice[] {
  return Object.values(state.instances);
}

export function selectByStatus(state: AppState, status: InstanceStatus): InstanceSlice[] {
  return Object.values(state.instances).filter((s) => s.status === status);
}

export function selectCanCreate(state: AppState, maxInstances: number): boolean {
  if (state.global.creationPaused) return false;
  if (state.global.shutdownRequested) return false;
  return Object.keys(state.instances).length < maxInstances;
}

export function selectInstanceCount(state: AppState): number {
  return Object.keys(state.instances).length;
}

export function selectTotalTokens(state: AppState): number {
  return Object.values(state.instances).reduce((sum, s) => sum + s.totalTokensUsed, 0);
}
