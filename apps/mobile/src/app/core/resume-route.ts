/**
 * Pure helpers for resume-where-you-left-off (kept Angular-free so they're
 * unit-testable without the router). See ResumeService for the wiring.
 */

/** Don't restore into a screen older than this — land on Hosts as usual. */
export const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SavedRoute {
  url: string;
  at: number;
}

/** Screens worth returning to after iOS evicts the backgrounded app. */
export function isRestorableUrl(url: string): boolean {
  return url.startsWith('/projects') || url.startsWith('/history');
}

/** Parse + validate a persisted route; null when absent, malformed, or stale. */
export function parseSavedRoute(value: string | null, now: number): SavedRoute | null {
  if (!value) return null;
  try {
    const saved = JSON.parse(value) as Partial<SavedRoute>;
    if (typeof saved.url !== 'string' || typeof saved.at !== 'number') return null;
    if (!isRestorableUrl(saved.url)) return null;
    if (now - saved.at > RESUME_MAX_AGE_MS) return null;
    return { url: saved.url, at: saved.at };
  } catch {
    return null;
  }
}
