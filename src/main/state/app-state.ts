// src/main/state/app-state.ts
import type { InstanceStatus, ContextUsage, InstanceProvider } from '../../shared/types/instance.types';

export interface InstanceSlice {
  id: string;
  displayName: string;
  status: InstanceStatus;
  contextUsage: ContextUsage;
  lastActivity: number;
  provider: InstanceProvider;
  currentModel?: string;
  parentId: string | null;
  childrenIds: string[];
  agentId: string;
  workingDirectory: string;
  processId: number | null;
  errorCount: number;
  totalTokensUsed: number;
}

export interface AppState {
  instances: Record<string, InstanceSlice>;
  global: {
    memoryPressure: 'normal' | 'warning' | 'critical';
    creationPaused: boolean;
    activeTaskCount: number;
    shutdownRequested: boolean;
  };
}

export const INITIAL_APP_STATE: AppState = {
  instances: {},
  global: {
    memoryPressure: 'normal',
    creationPaused: false,
    activeTaskCount: 0,
    shutdownRequested: false,
  },
};
