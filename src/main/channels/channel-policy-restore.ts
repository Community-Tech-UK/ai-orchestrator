import type { ChannelPlatform } from '../../shared/types/channels';
import type { BaseChannelAdapter } from './channel-adapter';
import type { ChannelAccessPolicyStore } from './channel-access-policy-store';

/**
 * Rehydrate persisted access policy before connecting a channel adapter.
 * Returns the allowlist that should also be passed through ChannelConfig.
 */
export function restoreSavedAccessPolicy(
  adapter: BaseChannelAdapter,
  platform: ChannelPlatform,
  policyStore: ChannelAccessPolicyStore,
): string[] {
  const savedPolicy = policyStore.get(platform);
  if (!savedPolicy) {
    return adapter.getAccessPolicy().allowedSenders;
  }

  const restored = policyStore.toAccessPolicy(savedPolicy);
  adapter.setAccessPolicy({
    ...adapter.getAccessPolicy(),
    mode: restored.mode,
    allowedSenders: restored.allowedSenders,
  });

  return restored.allowedSenders;
}
