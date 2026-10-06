import type { AgentToolPermissions, ToolPermission } from '../../shared/types/agent.types';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type {
  SideChatAuthorityPolicy,
  SideChatAuthorityResolution,
  SideChatParentRef,
  SideChatProvider,
  SideChatProviderCapability,
} from '../../shared/types/side-chat.types';
import { SIDE_CHAT_PROVIDERS } from '../../shared/types/side-chat.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { ChatStore } from './chat-store';
import type { SideChatLinkStore } from './side-chat-link-store';

/** Tools denied unconditionally across every provider (print-mode, host CLI). */
const MANDATORY_DENY_TOOLS = [
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
];

/** Chats spawn their runtimes under this agent (see ChatService.ensureRuntime). */
const CHAT_RUNTIME_AGENT_ID = 'build';

/** A sidechat of a sidechat inherits through its own parent, to this depth. */
const MAX_INHERITANCE_DEPTH = 4;

const TOOL_PERMISSION_VALUES: readonly ToolPermission[] = ['allow', 'deny', 'ask'];
const PERMISSION_CATEGORIES = ['read', 'write', 'bash', 'web', 'task'] as const;

export interface SideChatAuthorityDeps {
  chatStore: ChatStore;
  instanceManager: Pick<InstanceManager, 'getInstance' | 'getAllInstances'>;
  linkStore: Pick<SideChatLinkStore, 'get'>;
  /**
   * Resolve an agent profile's permissions the same way instance creation does
   * (`AgentRegistry.resolveAgent`), so a custom restrictive agent is never read
   * back as the permissive built-in default.
   */
  resolveAgentPermissions: (
    workingDirectory: string,
    agentId: string | null,
  ) => Promise<AgentToolPermissions>;
  /** Load a persisted policy for a parent whose live runtime is absent. */
  loadPersistedPolicy?: (parent: SideChatParentRef) => SideChatAuthorityPolicy | null;
  /** Persist a resolved policy so runtime replacement can reload it. */
  persistPolicy?: (parent: SideChatParentRef, policy: SideChatAuthorityPolicy) => void;
}

/**
 * Resolves the parent's effective edit/tool/approval/sandbox policy.
 *
 * Key invariants:
 * - Authority is always `inherit-parent`. There is no independent enable-editing
 *   toggle and no read-only default.
 * - The policy is read from the parent's runtime (its resolved agent, explicit
 *   tool override, YOLO posture, Seatbelt/contained execution, browser and
 *   Computer Use modes and execution node) — never from prompt text.
 * - Completed approval grants, credentials and execution tokens are NEVER
 *   copied: the policy holds only configuration.
 * - If the parent is absent and no verified persisted policy exists, the
 *   resolution is `unavailable-permissions` — even when a last context snapshot
 *   exists. Stale transcript context does not authorise editing.
 */
export class SideChatAuthorityResolver {
  constructor(private readonly deps: SideChatAuthorityDeps) {}

  async resolve(parent: SideChatParentRef, depth = 0): Promise<SideChatAuthorityResolution> {
    if (depth > MAX_INHERITANCE_DEPTH) {
      return unavailable('Sidechat inheritance chain is too deep to resolve permissions safely.');
    }
    const live = await this.resolveLiveParentPolicy(parent, depth);
    if (live && !live.ok) {
      return live;
    }
    if (live?.ok) {
      this.deps.persistPolicy?.(parent, live.policy);
      return { ok: true, policy: live.policy, source: 'live-parent' };
    }

    const persisted = this.deps.loadPersistedPolicy?.(parent) ?? null;
    if (persisted && isVerifiedPolicy(persisted)) {
      return { ok: true, policy: persisted, source: 'persisted' };
    }

    return unavailable(
      'Parent session is unavailable and no verified permission policy is persisted. Cannot authorise sidechat edits.',
    );
  }

  private async resolveLiveParentPolicy(
    parent: SideChatParentRef,
    depth: number,
  ): Promise<SideChatAuthorityResolution | null> {
    const instance = this.findParentInstance(parent);
    if (instance) {
      const permissions = instance.toolPermissionsOverride
        ?? await this.deps.resolveAgentPermissions(instance.workingDirectory, instance.agentId ?? null);
      return {
        ok: true,
        source: 'live-parent',
        policy: buildPolicy({
          agentToolPermissions: permissions,
          yoloMode: instance.yoloMode,
          hardened: instance.hardened ?? false,
          containedExecution: instance.containedExecution ?? false,
          browserToolsMode: instance.browserToolsMode ?? null,
          computerUseMode: instance.computerUseMode ?? null,
          workspaceNode: instance.workerNodeId ?? null,
        }),
      };
    }
    if (parent.kind !== 'chat') {
      return null;
    }
    const chat = this.deps.chatStore.get(parent.chatId);
    if (!chat) {
      return null;
    }
    // A parent chat that is itself a sidechat inherits through its own parent:
    // its stored `yolo` flag is not an authority source.
    const grandparent = this.deps.linkStore.get(chat.id);
    if (grandparent) {
      const inherited = await this.resolve(grandparent.parent, depth + 1);
      return inherited.ok ? { ...inherited, source: 'live-parent' } : inherited;
    }
    // A plain chat with no live runtime (e.g. before its first send) spawns
    // under the build agent with its stored YOLO posture; resolve exactly that.
    const permissions = await this.deps.resolveAgentPermissions(
      chat.currentCwd ?? '',
      CHAT_RUNTIME_AGENT_ID,
    );
    return {
      ok: true,
      source: 'live-parent',
      policy: buildPolicy({
        agentToolPermissions: permissions,
        yoloMode: chat.yolo,
        hardened: false,
        containedExecution: false,
        browserToolsMode: null,
        computerUseMode: null,
        workspaceNode: null,
      }),
    };
  }

  private findParentInstance(parent: SideChatParentRef) {
    if (parent.kind === 'chat') {
      const chat = this.deps.chatStore.get(parent.chatId);
      const instance = chat?.currentInstanceId
        ? this.deps.instanceManager.getInstance(chat.currentInstanceId)
        : undefined;
      return instance && instance.status !== 'terminated' ? instance : null;
    }
    for (const instance of this.deps.instanceManager.getAllInstances()) {
      if (instance.historyThreadId === parent.historyThreadId && instance.status !== 'terminated') {
        return instance;
      }
    }
    return null;
  }
}

function unavailable(error: string): SideChatAuthorityResolution {
  return { ok: false, code: 'unavailable-permissions', error };
}

export function buildPolicy(input: Omit<SideChatAuthorityPolicy, 'mandatoryDenyTools' | 'resolvedAt'>): SideChatAuthorityPolicy {
  return {
    ...input,
    agentToolPermissions: { ...input.agentToolPermissions },
    mandatoryDenyTools: [...MANDATORY_DENY_TOOLS],
    resolvedAt: Date.now(),
  };
}

/**
 * A persisted policy is only trusted when every enforcement-relevant field is
 * present and well-formed. A truncated or hand-edited row is treated as absent,
 * which fails closed to `unavailable-permissions`.
 */
export function isVerifiedPolicy(value: unknown): value is SideChatAuthorityPolicy {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Partial<SideChatAuthorityPolicy>;
  const permissions = policy.agentToolPermissions as Partial<AgentToolPermissions> | undefined;
  if (!permissions || typeof permissions !== 'object') return false;
  for (const category of PERMISSION_CATEGORIES) {
    if (!TOOL_PERMISSION_VALUES.includes(permissions[category] as ToolPermission)) return false;
  }
  return typeof policy.yoloMode === 'boolean'
    && typeof policy.hardened === 'boolean'
    && typeof policy.containedExecution === 'boolean'
    && Array.isArray(policy.mandatoryDenyTools)
    && (policy.workspaceNode === null || typeof policy.workspaceNode === 'string')
    && (policy.browserToolsMode === undefined || policy.browserToolsMode === null
      || policy.browserToolsMode === 'eager' || policy.browserToolsMode === 'deferred'
      || policy.browserToolsMode === 'off')
    && (policy.computerUseMode === undefined || policy.computerUseMode === null
      || policy.computerUseMode === 'guarded' || policy.computerUseMode === 'trusted'
      || policy.computerUseMode === 'unrestricted');
}

/**
 * Stable identity of the enforcement-relevant part of a policy. A change means
 * the sidechat's runtime was spawned under different restrictions and must be
 * replaced before its next turn (spawn-time flags cannot be edited in place).
 */
export function policyFingerprint(policy: SideChatAuthorityPolicy): string {
  const permissions = policy.agentToolPermissions;
  return JSON.stringify([
    PERMISSION_CATEGORIES.map((category) => permissions[category]),
    policy.yoloMode,
    policy.hardened,
    policy.containedExecution,
    policy.browserToolsMode ?? null,
    policy.computerUseMode ?? null,
    policy.workspaceNode ?? null,
    [...policy.mandatoryDenyTools].sort(),
  ]);
}

function deniedCategories(policy: SideChatAuthorityPolicy): string[] {
  return PERMISSION_CATEGORIES.filter((category) => policy.agentToolPermissions[category] === 'deny');
}

/**
 * Check whether a provider can enforce the parent's policy at its runtime
 * boundary. Returns a concrete unavailable capability instead of silently
 * relaxing restrictions.
 *
 * Enforcement facts (adapter-factory.ts / claude-cli-argv-builder.ts):
 * - Claude (local or worker) receives per-category denials as
 *   `--disallowedTools` and honours approval posture through the permission
 *   hook, so it can enforce any policy.
 * - Local models run as plain conversations with no tool execution, so they
 *   can never exceed any policy.
 * - Codex, Gemini, Antigravity, Cursor, Grok and OpenCode honour the YOLO /
 *   approval posture through their own non-YOLO modes but ignore per-category
 *   denials, so a parent that denies a category cannot use them.
 * - Copilot is always spawned with `--allow-all-tools --allow-all-paths`, so it
 *   can only run for a fully permissive parent.
 */
export function providerCanEnforcePolicy(
  provider: SideChatProvider | string,
  policy: SideChatAuthorityPolicy,
): { ok: true } | { ok: false; capability: string } {
  if (provider === 'claude' || provider === 'local-model') {
    return { ok: true };
  }
  const denied = deniedCategories(policy);
  if (provider === 'copilot' && !policy.yoloMode) {
    return {
      ok: false,
      capability: 'Copilot always runs with every tool and path allowed, so it cannot follow the parent session\'s approval requirement',
    };
  }
  if (denied.length > 0) {
    return {
      ok: false,
      capability: `${providerLabel(provider)} cannot block individual tool categories, and the parent session denies ${denied.join(', ')}`,
    };
  }
  return { ok: true };
}

export function describeProviderCapabilities(
  policy: SideChatAuthorityPolicy | null,
  unavailableReason: string | null,
): SideChatProviderCapability[] {
  return SIDE_CHAT_PROVIDERS.map((provider) => {
    if (!policy) {
      return { provider, available: false, reason: unavailableReason ?? 'Parent permissions are unavailable' };
    }
    const result = providerCanEnforcePolicy(provider, policy);
    return result.ok
      ? { provider, available: true, reason: null }
      : { provider, available: false, reason: result.capability };
  });
}

/**
 * Translate an inherited policy into the instance-creation fields that enforce
 * it. Never broadens: every restriction maps to a spawn-time flag.
 */
export function policyToRuntimeConfig(
  policy: SideChatAuthorityPolicy,
): Pick<InstanceCreateConfig,
  'toolPermissionsOverride' | 'yoloMode' | 'hardened' | 'containedExecution'
  | 'browserToolsMode' | 'computerUseMode' | 'forceNodeId'> {
  return {
    toolPermissionsOverride: { ...policy.agentToolPermissions },
    yoloMode: policy.yoloMode,
    ...(policy.hardened ? { hardened: true } : {}),
    ...(policy.containedExecution ? { containedExecution: true } : {}),
    ...(policy.browserToolsMode ? { browserToolsMode: policy.browserToolsMode } : {}),
    ...(policy.computerUseMode ? { computerUseMode: policy.computerUseMode } : {}),
    ...(policy.workspaceNode ? { forceNodeId: policy.workspaceNode } : {}),
  };
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'codex': return 'Codex';
    case 'gemini': return 'Gemini';
    case 'antigravity': return 'Antigravity';
    case 'copilot': return 'Copilot';
    case 'cursor': return 'Cursor';
    case 'grok': return 'Grok';
    case 'opencode': return 'OpenCode';
    default: return provider;
  }
}
