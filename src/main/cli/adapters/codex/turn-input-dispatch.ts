import type { AdapterInputDispatch } from '../base-cli-adapter.types';
import { assertAdapterInputCurrent } from '../adapter-input-dispatch';
import type { CodexCliConfig } from '../codex-adapter-config';
import type { CaptureCodexTurnOptions } from './app-server-thread-runtime';

/** Admission is kept in closures, apart from the serializable native turn parameters. */
export function buildCodexTurnInputDispatch(
  config: CodexCliConfig,
  dispatch: AdapterInputDispatch | undefined,
  hasNativeOwner: () => boolean,
  hasProviderOwner: () => boolean,
): Pick<CaptureCodexTurnOptions, 'turnParams' | 'beforeInputDispatch' | 'assertInputCurrent' | 'autoContinuation'> {
  const turnParams: Record<string, unknown> = {};
  if (config.outputSchema) turnParams['outputSchema'] = config.outputSchema;
  if (config.reasoningEffort) turnParams['effort'] = config.reasoningEffort;
  if (config.fastMode) turnParams['serviceTier'] = 'priority';
  return {
    turnParams,
    beforeInputDispatch: () => {
      assertAdapterInputCurrent(dispatch, hasNativeOwner());
      dispatch?.beforeProviderDispatch?.();
    },
    assertInputCurrent: () => assertAdapterInputCurrent(dispatch, hasProviderOwner()),
    autoContinuation: dispatch?.autoContinuation,
  };
}
