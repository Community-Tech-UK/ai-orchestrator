export const REMOTE_REVIEWER_PROVIDER_IDS = [
  'claude', 'codex', 'antigravity', 'copilot', 'cursor', 'grok',
] as const;

export type RemoteReviewerProvider =
  typeof REMOTE_REVIEWER_PROVIDER_IDS[number];

export const REMOTE_REVIEWER_PROVIDER_DEFINITIONS: readonly {
  id: RemoteReviewerProvider;
  label: string;
}[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'OpenAI Codex CLI' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'cursor', label: 'Cursor CLI' },
  { id: 'grok', label: 'Grok Build' },
] as const;

export function normalizeRemoteReviewerProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'gemini' ? 'antigravity' : normalized;
}
