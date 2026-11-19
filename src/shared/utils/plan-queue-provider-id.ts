/**
 * Lowercase CLI id, with the same legacy aliasing as `mapSettingsToDetectionType`
 * (`openai` → codex, `gemini` → antigravity), so a choice is checked against the
 * "never auto-pick" list under the CLI that will actually run. Shared by the queue's routing and by the Plan Queue
 * page, which compares a run's providers with the ones a Linear team allows.
 */
export function canonicalProvider(provider: string): string {
  const id = provider.trim().toLowerCase();
  return id === 'openai' ? 'codex' : id === 'gemini' ? 'antigravity' : id;
}
