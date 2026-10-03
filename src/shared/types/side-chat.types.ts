/**
 * Session-linked sidechat relationship types.
 *
 * A sidechat is an ordinary durable chat (`chats` row + ledger conversation)
 * plus a persisted ownership relation to a parent session. Ownership is keyed
 * by stable logical identity only — never by runtime instance id, provider
 * session id or working directory — so parent restart, compaction, hibernation,
 * native-session replacement and provider switch cannot detach a sidechat.
 */

import type { ReasoningEffort } from './provider.types';
import type { ModelRuntimeTarget } from './local-model-runtime.types';
import type { AgentToolPermissions } from './agent.types';

/**
 * Stable identity of the session a sidechat is linked to.
 *
 * - `chat`: a durable top-level chat. Ownership key is its chat id.
 * - `session`: a logical session thread. Ownership key is `historyThreadId`
 *   (stable across restore/fallback). `originNodeId` is workspace provenance
 *   only and is deliberately excluded from the ownership key, because a node
 *   route can change while the session identity does not.
 */
export type SideChatParentRef =
  | { kind: 'chat'; chatId: string }
  | { kind: 'session'; historyThreadId: string; originNodeId: string | null };

/**
 * Authority policy for a sidechat. The only value is `inherit-parent`: the
 * sidechat resolves the parent's effective edit/tool/approval/sandbox policy at
 * creation and before each dispatch. There is no independent read-only default
 * or enable-editing toggle.
 */
export type SideChatAuthority = 'inherit-parent';

export interface SideChatLink {
  chatId: string;
  parent: SideChatParentRef;
  authority: SideChatAuthority;
  /**
   * High-water mark of the last assistant message sequence the user has
   * actually viewed in this sidechat. Advanced only on explicit read
   * acknowledgement and never moves backwards.
   */
  lastReadAssistantSequence: number;
}

/**
 * Deterministic ownership key for a parent reference. Two parents in the same
 * directory never collide; a replacement runtime for the same logical session
 * resolves to the same key.
 */
export function sideChatParentKey(parent: SideChatParentRef): string {
  return parent.kind === 'chat'
    ? `chat:${parent.chatId}`
    : `session:${parent.historyThreadId}`;
}

export function sideChatParentsEqual(
  left: SideChatParentRef,
  right: SideChatParentRef,
): boolean {
  return sideChatParentKey(left) === sideChatParentKey(right);
}

/**
 * Immutable snapshot of parent context captured before dispatching a sidechat
 * question. `revision` changes on rewind or content replacement, not merely on
 * an increasing message sequence.
 */
export interface ParentContextSnapshot {
  parent: SideChatParentRef;
  revision: string;
  capturedAt: number;
  title: string;
  estimatedTokens: number;
  /** Explicit record of what the budget left out (oldest detail, tool noise…). */
  omissions: string[];
  /**
   * Parent content framed as quoted data under the prompt house style. Parent
   * instructions, tool results and transcripts can never override the
   * sidechat's own authority.
   */
  quotedContext: string;
}

/**
 * Aggregated sidechat activity for one parent. Counts refer to conversations
 * with unread answers, never to streaming chunks.
 */
export interface SideChatAttention {
  parent: SideChatParentRef;
  total: number;
  running: number;
  unread: number;
  needsAttention: number;
}

// ── Provider selection and authority (Task 3) ──────────────────────────────────

/**
 * Providers a sidechat can target. Superset of `ChatProvider`: the unified
 * picker surfaces Cursor, Grok, OpenCode and local models where the session
 * runtime supports them. `local-model` routes through `modelRuntimeTarget`.
 */
export type SideChatProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'copilot'
  | 'cursor'
  | 'grok'
  | 'opencode'
  | 'local-model';

/**
 * Concrete provider selection DTO from the unified picker. Carries model,
 * reasoning and local runtime target so a local-model selection survives every
 * seam (validation, persistence, reload, runtime config, switch, rebuild).
 */
export interface SideChatProviderSelection {
  provider: SideChatProvider;
  model?: string | null;
  reasoning?: ReasoningEffort | null;
  modelRuntimeTarget?: ModelRuntimeTarget | null;
}

/**
 * Effective permission policy inherited from the parent session. Captured at
 * creation and before each dispatch. This is a POLICY, not a grant: completed
 * approval grants, credentials and execution tokens are never copied.
 */
export interface SideChatAuthorityPolicy {
  agentToolPermissions: AgentToolPermissions;
  yoloMode: boolean;
  hardened: boolean;
  containedExecution: boolean;
  /**
   * Provider-specific mandatory restrictions that must survive translation
   * (e.g. Claude's print-mode tool denials). Never broadened on provider change.
   */
  mandatoryDenyTools: string[];
  /** Workspace/execution node provenance from the parent. */
  workspaceNode: string | null;
  /** When the policy was resolved. Stale policies are re-resolved on dispatch. */
  resolvedAt: number;
}

/**
 * Result of attempting to resolve the parent's authority. `unavailable` means
 * the parent is absent AND no verified persisted policy exists — the sidechat
 * must refuse to dispatch even when a last context snapshot is on file.
 */
export type SideChatAuthorityResolution =
  | { ok: true; policy: SideChatAuthorityPolicy; source: 'live-parent' | 'persisted' }
  | { ok: false; code: 'unavailable-permissions'; error: string };
