import type { ChatProvider } from '../../../../shared/types/chat.types';
import type { ReasoningEffort } from '../../../../shared/types/provider.types';

/**
 * Operating mode of the compact model picker.
 *
 *   - `live-instance`: bound to a `ChatRecord`. Selection commits via
 *     `ChatStore.setProvider/setModel/setReasoning`, which terminate the
 *     chat's running runtime so the next message spawns a fresh one with
 *     the new config.
 *   - `pending-create`: the new-chat form before a chat exists. Selection
 *     is held in a `[(selection)]`-bound signal and read at "Create" time.
 */
export type CompactPickerMode = 'live-instance' | 'pending-create';

/**
 * Form state held by the new-chat sidebar before a chat exists. Two-way
 * bound on `<app-compact-model-picker mode="pending-create" [(selection)]>`.
 */
export interface PendingSelection {
  provider: ChatProvider;
  model: string | null;
  reasoning: ReasoningEffort | null;
}

/**
 * Target of a single commit through `ModelPickerController.commitSelection`.
 * Any subset of fields may be set; absent fields mean "leave unchanged".
 */
export interface CommitTarget {
  provider?: ChatProvider;
  modelId?: string | null;
  reasoning?: ReasoningEffort | null;
}
