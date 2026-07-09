/**
 * Per-model usage stats for hybrid picker ranking.
 * Keyed externally as `provider:modelId` in `AppSettings.modelUsageByKey`.
 */
export interface ModelUsageEntry {
  /** Times this model was selected. */
  count: number;
  /** Epoch ms of the most recent selection. */
  lastUsedAt: number;
}
