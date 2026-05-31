import ElectronStore from 'electron-store';
import type { PromptHistoryStoreV1 } from '../../shared/types/prompt-history.types';

export interface PromptHistoryStoreBackend {
  get<K extends keyof PromptHistoryStoreV1>(key: K): PromptHistoryStoreV1[K];
  set<K extends keyof PromptHistoryStoreV1>(key: K, value: PromptHistoryStoreV1[K]): void;
  setMany?(values: Partial<PromptHistoryStoreV1>): void;
}

export const PROMPT_HISTORY_DEFAULTS: PromptHistoryStoreV1 = {
  schemaVersion: 1,
  byInstance: {},
  byProject: {},
};

/**
 * Minimal structural view of the electron-store instance we rely on.
 *
 * electron-store v10 (and its `conf` dependency) are ESM-only and expose their
 * type declarations exclusively through the package `exports` map. The
 * main-process project compiles with the classic `moduleResolution: "node"`
 * (see tsconfig.electron.json), which doesn't honour `exports`, so the library's
 * own generic `Store<T>` type resolves incorrectly and reports phantom
 * "two different types" / missing-method errors. Wrapping the instance in this
 * local interface (and constructing without the generic) keeps the call sites
 * fully typed via PromptHistoryStoreBackend without depending on the library's
 * mis-resolved typings.
 */
interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  set(values: Partial<PromptHistoryStoreV1>): void;
}

export function createPromptHistoryElectronStore(): PromptHistoryStoreBackend {
  const store = new ElectronStore<PromptHistoryStoreV1>({
    name: 'prompt-history',
    defaults: PROMPT_HISTORY_DEFAULTS,
  }) as unknown as KeyValueStore;

  return {
    get: <K extends keyof PromptHistoryStoreV1>(key: K): PromptHistoryStoreV1[K] =>
      store.get(key as string) as PromptHistoryStoreV1[K],
    set: <K extends keyof PromptHistoryStoreV1>(key: K, value: PromptHistoryStoreV1[K]): void => {
      store.set(key as string, value);
    },
    setMany: (values: Partial<PromptHistoryStoreV1>): void => {
      store.set(values);
    },
  };
}
