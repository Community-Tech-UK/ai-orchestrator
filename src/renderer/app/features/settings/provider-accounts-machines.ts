/**
 * Per-machine MiMo sign-in state for the Provider Accounts settings tab.
 *
 * A MiMo sign-in lives on each machine (OpenCode keeps one key store per
 * machine), so the tab shows, per account, which connected worker already has
 * that account's key and the exact `opencode auth login` command to run on one
 * that does not. The roster comes from each worker's own `opencode auth list`
 * advertisement (names only) — a placement hint; the spawn-time binding check
 * decides. Nothing here may carry a path or a credential.
 */

import { openCodeAccountLoginCommand } from '../../../../shared/utils/opencode-account-login-command';
import type { ProviderAccountView } from '../../core/services/ipc/provider-account-ipc.service';

export interface AccountMachineState {
  nodeId: string;
  name: string;
  hasAccount: boolean;
}

export interface AccountMachineNode {
  id: string;
  name: string;
  capabilities: { accountProfileIds?: Partial<Record<string, string[]>> };
}

export function accountMachinesFor(
  account: ProviderAccountView,
  nodes: readonly AccountMachineNode[],
): AccountMachineState[] {
  if (account.provider !== 'opencode') return [];
  return nodes.map((node) => ({
    nodeId: node.id,
    name: node.name,
    hasAccount: (node.capabilities.accountProfileIds?.['opencode'] ?? []).includes(account.id),
  }));
}

/** The exact per-account sign-in command to run on another machine (no secret). */
export function nodeLoginCommandFor(account: ProviderAccountView): string {
  try {
    return openCodeAccountLoginCommand({
      id: account.id,
      isLegacy: account.isLegacy,
      region: account.region,
    });
  } catch {
    return 'opencode auth login';
  }
}
