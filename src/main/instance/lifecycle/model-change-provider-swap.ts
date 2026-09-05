/**
 * Cross-provider swap helpers for `InstanceLifecycleManager.changeModel`.
 *
 * A provider swap reuses the model-change flow (mutex, status gate, adapter
 * replacement) but must additionally:
 *   - verify the target CLI is actually available where the instance runs
 *     (local detection, or the worker node's advertised CLIs for remote
 *     instances — local detection says nothing about a remote box);
 *   - resolve a model when the picker didn't pin one (remembered per-provider
 *     default, then global default, then the provider's own default);
 *   - translate the unified reasoning effort into something the target
 *     provider understands, dropping it with a logged notice otherwise.
 *
 * Extracted from instance-lifecycle.ts to keep that file inside its LOC budget.
 */

import { resolveCliType, getCliDisplayName } from '../../cli/adapters/adapter-factory';
import { getWorkerNodeRegistry } from '../../remote-node/worker-node-registry';
import { getLogger } from '../../logging/logger';
import { resolveInitialModel } from './resolve-initial-model';
import type { Instance, InstanceProvider } from '../../../shared/types/instance.types';
import type { ReasoningEffort } from '../../../shared/types/provider.types';
import type { AppSettings } from '../../../shared/types/settings.types';

const logger = getLogger('ModelChangeProviderSwap');

/** Concrete providers a session can swap to — the 'auto' sentinel never is one. */
export type SwapTargetProvider = Exclude<InstanceProvider, 'auto'>;

/**
 * Unified reasoning efforts each provider's adapter actually honours.
 * Mirrors the renderer's `ModelPickerController.reasoningOptionsForProvider`;
 * providers absent from this table ignore the flag entirely.
 */
const PROVIDER_REASONING_EFFORTS: Partial<Record<InstanceProvider, readonly ReasoningEffort[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max', 'workflow'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

/**
 * Map a unified reasoning effort onto the target provider. Returns the effort
 * unchanged when supported, the nearest supported tier when there is an
 * obvious one (Claude workflow maps to Codex xhigh), and undefined (provider default) when
 * the target has no equivalent — logging the drop so it is diagnosable.
 */
export function mapReasoningEffortForProvider(
  provider: SwapTargetProvider,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (effort === undefined) return undefined;
  const supported = PROVIDER_REASONING_EFFORTS[provider];
  if (!supported) {
    logger.info('Dropping reasoning effort — target provider has no equivalent', { provider, effort });
    return undefined;
  }
  if (supported.includes(effort)) return effort;
  if (provider === 'codex' && effort === 'workflow') {
    logger.info('Mapping reasoning effort to nearest supported tier', { provider, effort, mapped: 'xhigh' });
    return 'xhigh';
  }
  logger.info('Dropping reasoning effort — unsupported by target provider', { provider, effort });
  return undefined;
}

/**
 * Throw unless the target CLI is available where the instance executes.
 * Local instances use the same detection as create time; remote instances are
 * checked against the worker node's advertised `supportedClis` (decision 5 —
 * cheap validation instead of a blanket remote rejection).
 */
export async function assertSwapTargetCliAvailable(
  instance: Instance,
  targetProvider: SwapTargetProvider,
  defaultCli: AppSettings['defaultCli'],
): Promise<void> {
  const location = instance.executionLocation;
  if (location?.type === 'remote') {
    const node = getWorkerNodeRegistry().getNode(location.nodeId);
    if (!node) {
      throw new Error(
        `Cannot switch provider: remote node ${location.nodeId} is no longer registered.`,
      );
    }
    const supported = node.capabilities.supportedClis.some(
      (cli) => cli.toLowerCase() === targetProvider.toLowerCase(),
    );
    if (!supported) {
      throw new Error(
        `Cannot switch provider: worker node "${node.name}" does not have the `
        + `${getCliDisplayName(targetProvider)} CLI available.`,
      );
    }
    return;
  }

  // resolveCliType silently falls back when the requested CLI is missing; a
  // user-initiated swap must fail loudly instead of landing on a surprise CLI.
  const resolved = await resolveCliType(targetProvider, defaultCli);
  if (resolved !== targetProvider) {
    throw new Error(
      `Cannot switch provider: the ${getCliDisplayName(targetProvider)} CLI is not installed or not available.`,
    );
  }
}

/**
 * Where a swap's model came from. Only `requested` and `remembered` represent a
 * choice the *user* made for this provider; `global-default` is the legacy
 * `AppSettings.defaultModel`, which is a single id shared across every provider
 * and is therefore routinely wrong for a swap target (LT-016).
 */
export type SwapModelSource = 'requested' | 'remembered' | 'global-default' | 'provider-default';

export interface SwapModelResolution {
  model?: string;
  source: SwapModelSource;
}

/**
 * Resolve the model for a provider swap when the caller didn't pin one:
 * remembered per-provider default → global default → undefined (provider's
 * own default). Mirrors `resolve-initial-model.ts` precedence minus the
 * config/agent overrides, which don't apply to a live swap.
 */
export function resolveSwapModel(
  targetProvider: SwapTargetProvider,
  requestedModel: string | undefined,
  settings: Pick<AppSettings, 'defaultModelByProvider' | 'defaultModel'>,
): string | undefined {
  return resolveSwapModelWithSource(targetProvider, requestedModel, settings).model;
}

/**
 * Same resolution as `resolveSwapModel`, but reports which rung supplied the
 * model. Callers need this to tell a *stale user selection* (worth telling the
 * user about when the provider rejects it) from the global default simply not
 * belonging to the target provider (never worth telling the user about, because
 * they never chose it for this provider) — LT-016.
 */
export function resolveSwapModelWithSource(
  targetProvider: SwapTargetProvider,
  requestedModel: string | undefined,
  settings: Pick<AppSettings, 'defaultModelByProvider' | 'defaultModel'>,
): SwapModelResolution {
  if (requestedModel !== undefined && requestedModel.trim() !== '') {
    return { model: requestedModel, source: 'requested' };
  }

  const remembered = settings.defaultModelByProvider?.[targetProvider];
  if (remembered) {
    return { model: remembered, source: 'remembered' };
  }

  const resolved = resolveInitialModel({
    provider: targetProvider,
    defaultModelByProvider: settings.defaultModelByProvider,
    defaultModel: settings.defaultModel,
  });
  return resolved === undefined
    ? { model: undefined, source: 'provider-default' }
    : { model: resolved, source: 'global-default' };
}
