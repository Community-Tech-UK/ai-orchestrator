import { getSettingsManager } from '../core/config/settings-manager';

/** Both operator switches must allow agent-originated secret cards. */
export function areAgentSecretCardRequestsAllowed(): boolean {
  try {
    const settings = getSettingsManager().getAll();
    return settings.workspaceSecretsEnabled !== false
      && settings.workspaceSecretsAllowAgentRequests !== false;
  } catch {
    return false;
  }
}
