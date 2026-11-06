import { providerToolName } from '../display-names';

export const REMOTE_REVIEWER_PROVIDER_IDS = [
  'claude', 'codex', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode',
] as const;

export type RemoteReviewerProvider =
  typeof REMOTE_REVIEWER_PROVIDER_IDS[number];

export const REMOTE_REVIEWER_PROVIDER_DEFINITIONS: readonly {
  id: RemoteReviewerProvider;
  label: string;
}[] = REMOTE_REVIEWER_PROVIDER_IDS.map((id) => ({ id, label: providerToolName(id) }));

export function normalizeRemoteReviewerProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'gemini' ? 'antigravity' : normalized;
}
