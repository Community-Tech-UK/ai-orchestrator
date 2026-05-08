import type { ChatProvider } from '../../../../shared/types/chat.types';
import type { ReasoningEffort } from '../../../../shared/types/provider.types';

/**
 * Provider type accepted by the picker. Covers the four chat providers
 * plus `cursor` (which the new-session/instance-draft surface supports
 * even though chats currently don't). Excludes the `auto` sentinel —
 * the picker always pins a concrete provider.
 */
export type PickerProvider = ChatProvider | 'cursor';

/**
 * Operating mode of the compact model picker.
 *
 *   - `live-instance`: bound to a `ChatRecord`. Selection commits via
 *     `ChatStore.setProvider/setModel/setReasoning`, which terminate the
 *     chat's running runtime so the next message spawns a fresh one with
 *     the new config.
 *   - `pending-create`: form-state mode used before a backing record
 *     exists. Selection is held in a `[(selection)]`-bound signal and
 *     read at "Create" time. Used by the new-chat sidebar form AND the
 *     dashboard's new-session/instance-draft composer; the host narrows
 *     the provider to whatever its backend will accept.
 */
export type CompactPickerMode = 'live-instance' | 'pending-create';

/**
 * Form state held by a host before its record exists. Two-way bound on
 * `<app-compact-model-picker mode="pending-create" [(selection)]>`.
 *
 * `provider` is `PickerProvider` so the same shape can serve both the
 * chat-creation form (which narrows to `ChatProvider` at create time)
 * and the instance-creation form (which accepts cursor).
 */
export interface PendingSelection {
  provider: PickerProvider;
  model: string | null;
  reasoning: ReasoningEffort | null;
}

/**
 * Target of a single commit through `ModelPickerController.commitSelection`.
 * Any subset of fields may be set; absent fields mean "leave unchanged".
 */
export interface CommitTarget {
  provider?: PickerProvider;
  modelId?: string | null;
  reasoning?: ReasoningEffort | null;
}
