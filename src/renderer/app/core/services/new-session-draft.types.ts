import type { InstanceLaunchMode } from '../../../../shared/types/instance.types';
import type { ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';
import type { ReasoningEffort } from '../../../../shared/types/provider.types';
import type { ProviderType } from './provider-state.service';

export interface NewSessionDraftState {
  workingDirectory: string | null;
  prompt: string;
  provider: ProviderType | null;
  model: string | null;
  modelRuntimeTarget: ModelRuntimeTarget | null;
  reasoningEffort: ReasoningEffort | null;
  nodeId: string | null;
  yoloMode: boolean | null;
  /** WS13 — run the CLI inside the macOS Seatbelt jail. null = off. */
  hardened: boolean | null;
  launchMode: InstanceLaunchMode | null;
  agentId: string;
  pendingFolders: string[];
  updatedAt: number;
}

export interface NewSessionDraftStoreState {
  activeKey: string;
  drafts: Record<string, NewSessionDraftState>;
  revision: number;
}

export interface PersistedNewSessionDraft {
  workingDirectory: string | null;
  prompt: string;
  provider: ProviderType | null;
  model: string | null;
  modelRuntimeTarget?: ModelRuntimeTarget | null;
  reasoningEffort?: ReasoningEffort | null;
  nodeId?: string | null;
  yoloMode?: boolean | null;
  hardened?: boolean | null;
  launchMode?: InstanceLaunchMode | null;
  agentId?: string;
  pendingFolders: string[];
  updatedAt: number;
}

export interface PersistedNewSessionDraftStoreState {
  version: 1;
  activeKey: string;
  drafts: Record<string, PersistedNewSessionDraft>;
}
