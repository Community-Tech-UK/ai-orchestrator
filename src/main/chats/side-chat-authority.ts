import type { AgentToolPermissions } from '../../shared/types/agent.types';
import { getAgentById, getDefaultAgent } from '../../shared/types/agent.types';
import type {
  SideChatAuthorityPolicy,
  SideChatAuthorityResolution,
  SideChatParentRef,
} from '../../shared/types/side-chat.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { ChatStore } from './chat-store';
import { getLogger } from '../logging/logger';

const logger = getLogger('SideChatAuthority');

/** Tools denied unconditionally across every provider (print-mode, host CLI). */
const MANDATORY_DENY_TOOLS = [
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
];

export interface SideChatAuthorityDeps {
  chatStore: ChatStore;
  instanceManager: InstanceManager;
  /** Load a persisted policy for a parent whose live runtime is absent. */
  loadPersistedPolicy?: (parent: SideChatParentRef) => SideChatAuthorityPolicy | null;
  /** Persist a resolved policy so runtime replacement can reload it. */
  persistPolicy?: (parent: SideChatParentRef, policy: SideChatAuthorityPolicy) => void;
}

/**
 * Resolves the parent's effective edit/tool/approval/sandbox policy and
 * translates it for the sidechat's runtime.
 *
 * Key invariants:
 * - Authority is always `inherit-parent`. There is no independent enable-editing
 *   toggle and no read-only default.
 * - Restrictions are translated WITHOUT broadening scope. A provider change is
 *   not an authority escalation.
 * - Completed approval grants, credentials and execution tokens are NEVER copied.
 * - If the parent is absent and no verified persisted policy exists, the
 *   resolution is `unavailable-permissions` — even when a last context snapshot
 *   exists. Stale transcript context does not authorise editing.
 */
export class SideChatAuthorityResolver {
  constructor(private readonly deps: SideChatAuthorityDeps) {}

  resolve(parent: SideChatParentRef): SideChatAuthorityResolution {
    const livePolicy = this.resolveLiveParentPolicy(parent);
    if (livePolicy) {
      this.deps.persistPolicy?.(parent, livePolicy);
      return { ok: true, policy: livePolicy, source: 'live-parent' };
    }

    const persisted = this.deps.loadPersistedPolicy?.(parent) ?? null;
    if (persisted) {
      return { ok: true, policy: persisted, source: 'persisted' };
    }

    return {
      ok: false,
      code: 'unavailable-permissions',
      error: 'Parent session is unavailable and no verified permission policy is persisted. Cannot authorise sidechat edits.',
    };
  }

  private resolveLiveParentPolicy(parent: SideChatParentRef): SideChatAuthorityPolicy | null {
    const instance = this.findParentInstance(parent);
    if (instance) {
      const agent = instance.agentId
        ? getAgentById(instance.agentId) ?? getDefaultAgent()
        : getDefaultAgent();
      return this.buildPolicy({
        agentToolPermissions: agent.permissions,
        yoloMode: instance.yoloMode,
        hardened: instance.hardened ?? false,
        containedExecution: instance.containedExecution ?? false,
        workspaceNode: instance.workerNodeId ?? null,
      });
    }
    // Parent chat exists but has no live runtime (e.g. before the first send).
    // Resolve from the chat record's persisted posture so creation is still
    // authorised; the policy is re-resolved against the live runtime on dispatch.
    if (parent.kind === 'chat') {
      const chat = this.deps.chatStore.get(parent.chatId);
      if (chat) {
        const agent = getDefaultAgent();
        return this.buildPolicy({
          agentToolPermissions: agent.permissions,
          yoloMode: chat.yolo,
          hardened: false,
          containedExecution: false,
          workspaceNode: null,
        });
      }
    }
    return null;
  }

  private findParentInstance(parent: SideChatParentRef) {
    if (parent.kind === 'chat') {
      const chat = this.deps.chatStore.get(parent.chatId);
      return chat?.currentInstanceId
        ? this.deps.instanceManager.getInstance(chat.currentInstanceId)
        : null;
    }
    for (const instance of this.deps.instanceManager.getAllInstances()) {
      if (instance.historyThreadId === parent.historyThreadId && instance.status !== 'terminated') {
        return instance;
      }
    }
    return null;
  }

  buildPolicy(input: {
    agentToolPermissions: AgentToolPermissions;
    yoloMode: boolean;
    hardened: boolean;
    containedExecution: boolean;
    workspaceNode: string | null;
  }): SideChatAuthorityPolicy {
    return {
      agentToolPermissions: { ...input.agentToolPermissions },
      yoloMode: input.yoloMode,
      hardened: input.hardened,
      containedExecution: input.containedExecution,
      mandatoryDenyTools: [...MANDATORY_DENY_TOOLS],
      workspaceNode: input.workspaceNode,
      resolvedAt: Date.now(),
    };
  }
}

/**
 * Translate an inherited policy to the tool-permission shape consumed by
 * `buildToolPermissionConfig`. Never broadens: a category that was `deny` or
 * `ask` in the parent cannot become `allow` here.
 */
export function policyToAgentPermissions(
  policy: SideChatAuthorityPolicy,
): AgentToolPermissions {
  return { ...policy.agentToolPermissions };
}

/**
 * Check whether a provider can enforce the parent's policy. Returns a concrete
 * unavailable capability instead of silently relaxing restrictions.
 */
export function providerCanEnforcePolicy(
  provider: string,
  policy: SideChatAuthorityPolicy,
): { ok: true } | { ok: false; capability: string } {
  // Local models route through a constrained endpoint that cannot enforce
  // tool-level deny rules or approval posture. A restricted parent therefore
  // cannot use a local-model sidechat for edits.
  if (provider === 'local-model') {
    const needsEnforcement =
      policy.agentToolPermissions.write === 'deny'
      || policy.agentToolPermissions.bash === 'deny'
      || policy.agentToolPermissions.write === 'ask'
      || policy.agentToolPermissions.bash === 'ask'
      || policy.hardened
      || policy.containedExecution;
    if (needsEnforcement) {
      return {
        ok: false,
        capability: 'local-model runtimes cannot enforce the parent\'s tool/approval restrictions',
      };
    }
  }
  return { ok: true };
}
