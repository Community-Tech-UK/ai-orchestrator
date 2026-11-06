import { getSettingsManager } from '../core/config/settings-manager';

/** The same helper input budget applies to restart and in-place compaction. */
export function resolveCompactionInputLimit(read = () => getSettingsManager().get('auxiliaryLlmSlotsJson')): number {
  try {
    const slots = JSON.parse(read()) as { compression?: { maxInputTokens?: unknown } };
    const value = slots?.compression?.maxInputTokens;
    return typeof value === 'number' && Number.isFinite(value) && value >= 1
      ? Math.floor(value) : 96_000;
  } catch {
    return 96_000;
  }
}
