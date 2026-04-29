import ElectronStore from 'electron-store';
import type { PromptHistoryStoreV1 } from '../../shared/types/prompt-history.types';

export interface PromptHistoryStoreBackend {
  get<K extends keyof PromptHistoryStoreV1>(key: K): PromptHistoryStoreV1[K];
  set<K extends keyof PromptHistoryStoreV1>(key: K, value: PromptHistoryStoreV1[K]): void;
}

export const PROMPT_HISTORY_DEFAULTS: PromptHistoryStoreV1 = {
  schemaVersion: 1,
  byInstance: {},
  byProject: {},
};

export function createPromptHistoryElectronStore(): PromptHistoryStoreBackend {
  return new ElectronStore<PromptHistoryStoreV1>({
    name: 'prompt-history',
    defaults: PROMPT_HISTORY_DEFAULTS,
  }) as unknown as PromptHistoryStoreBackend;
}
