import type { ReasoningEffort } from '../../../../shared/types/provider.types';
import type { PickerProvider } from './compact-model-picker.types';

export interface UnifiedReasoningOption {
  id: 'default' | ReasoningEffort;
  label: string;
  /** Marks the provider's default effort for badging. */
  isDefault?: boolean;
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
