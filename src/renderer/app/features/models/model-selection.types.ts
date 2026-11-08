import type { ReasoningEffort } from '../../../../shared/types/provider.types';
import type { PickerProvider } from './compact-model-picker.types';

export interface UnifiedReasoningOption {
  id: 'default' | ReasoningEffort;
  label: string;
  description?: string;
  /** A few words, shown in the menu item, for an effort that uses much more of the allowance. */
  costNote?: string;
  /** Marks the provider's default effort for badging. */
  isDefault?: boolean;
  /** Displays a persisted selection outside the current advertised choices. */
  disabled?: boolean;
}

export type UnifiedSelection =
  | { kind: 'provider'; provider: PickerProvider }
  | { kind: 'model'; provider: PickerProvider; modelId: string }
  | {
      kind: 'reasoning';
      provider: PickerProvider;
      modelId: string;
      level: ReasoningEffort | null;
    };
