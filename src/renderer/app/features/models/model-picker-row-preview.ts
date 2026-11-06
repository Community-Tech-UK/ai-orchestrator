import type { PickerProvider } from './compact-model-picker.types';
import type { UnifiedReasoningOption, UnifiedSelection } from './model-selection.types';

/** The parts of a panel row that say what choosing it would do. */
interface PreviewRow {
  provider: PickerProvider;
  model: { id: string };
  disabledReason?: string | null;
  reasoningOptions: readonly UnifiedReasoningOption[];
  reasoningValue: string;
}

/** The selection a click on this row would make, or null when there is no row or it cannot be chosen. */
export function rowPreviewOf(row: PreviewRow | null): UnifiedSelection | null {
  return row && !row.disabledReason ? { kind: 'model', provider: row.provider, modelId: row.model.id } : null;
}

/**
 * Focusing the effort list: any other effort stands for "change the effort", which costs the same
 * whichever one is chosen.
 */
export function reasoningPreviewOf(row: PreviewRow, valueOf: (option: UnifiedReasoningOption) => string): UnifiedSelection | null {
  const other = row.reasoningOptions.find((option) => !option.disabled && valueOf(option) !== row.reasoningValue);
  return row.disabledReason || !other
    ? null
    : { kind: 'reasoning', provider: row.provider, modelId: row.model.id, level: other.id === 'default' ? null : other.id };
}
