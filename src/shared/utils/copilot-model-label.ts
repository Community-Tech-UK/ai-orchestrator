/** Display copy only: provider model IDs and actual measured billing stay unchanged. */
export function copilotModelLabel(id: string, fallback: string): string {
  return /^claude-opus-5[.-]5$/i.test(id.trim()) ? 'Opus 5.5 · 15 premium requests each' : fallback;
}
