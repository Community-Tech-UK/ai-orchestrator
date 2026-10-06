import type { ChatProvider } from '../../shared/types/chat.types';
import type {
  SideChatAuthorityPolicy,
  SideChatProviderSelection,
} from '../../shared/types/side-chat.types';
import { SIDE_CHAT_PROVIDERS } from '../../shared/types/side-chat.types';
import { providerCanEnforcePolicy } from './side-chat-authority';

/** Runtime statuses during which a sidechat turn is still running. */
export const SIDE_CHAT_BUSY_STATUSES = new Set([
  'initializing', 'busy', 'processing', 'thinking_deeply', 'waiting_for_permission',
  'interrupting', 'cancelling', 'interrupt-escalating', 'respawning', 'waking',
]);

/** A refused sidechat operation with a stable machine-readable code. */
export class SideChatError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SideChatError';
  }
}

export function assertProviderEnforceable(provider: string, policy: SideChatAuthorityPolicy): void {
  const enforcement = providerCanEnforcePolicy(provider, policy);
  if (!enforcement.ok) {
    throw new SideChatError('provider-unavailable', enforcement.capability);
  }
}

/**
 * Reject a provider selection the parent's policy cannot run: unknown
 * providers, a local model without a concrete target or on a different machine
 * from the parent's workspace, and providers that cannot enforce the policy.
 */
export function assertSelectionUsable(
  selection: SideChatProviderSelection,
  policy: SideChatAuthorityPolicy,
): void {
  if (!SIDE_CHAT_PROVIDERS.includes(selection.provider)) {
    throw new SideChatError('provider-unavailable', `Unknown sidechat provider ${String(selection.provider)}`);
  }
  if (selection.provider === 'local-model') {
    const target = selection.modelRuntimeTarget;
    if (target?.kind !== 'local-model') {
      throw new SideChatError('provider-unavailable', 'Choose a specific local model before starting this sidechat');
    }
    const targetNode = target.source === 'worker-node' ? target.nodeId ?? null : null;
    if (targetNode !== (policy.workspaceNode ?? null)) {
      throw new SideChatError(
        'provider-unavailable',
        'That local model runs on a different machine from the parent session\'s workspace',
      );
    }
  }
  assertProviderEnforceable(selection.provider, policy);
}

export function normalizeSelection(selection: SideChatProviderSelection): {
  provider: ChatProvider;
  model: string | null;
  reasoning: SideChatProviderSelection['reasoning'] | undefined;
  modelRuntimeTarget: SideChatProviderSelection['modelRuntimeTarget'] | null;
} {
  const target = selection.provider === 'local-model' ? selection.modelRuntimeTarget ?? null : null;
  return {
    provider: selection.provider,
    // A local-model selection always runs the target's own model id.
    model: target?.kind === 'local-model' ? target.modelId : selection.model ?? null,
    reasoning: selection.provider === 'local-model' ? null : selection.reasoning,
    modelRuntimeTarget: target,
  };
}
