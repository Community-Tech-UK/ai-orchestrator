import type { WakeHint } from './wake-context.types';
import { normalizeWakeHintContent } from './wake-context.types';

// Notes last shown before 4 May 2026 belong to the legacy backlog.
const LEGACY_CUTOFF = Date.UTC(2026, 4, 4);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function summarizeWakeHints(hints: readonly WakeHint[], now = Date.now()): {
  visible: WakeHint[]; hidden: WakeHint[]; different: number; shownThisWeek: number;
} {
  const seen = new Set<string>();
  const visible: WakeHint[] = [];
  const hidden: WakeHint[] = [];
  // Pick a currently used copy before any legacy duplicate, then highest importance.
  const ordered = [...hints].sort((a, b) => Number(isLegacy(a)) - Number(isLegacy(b))
    || b.importance - a.importance || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  for (const hint of ordered) {
    const key = normalizeWakeHintContent(hint.content);
    if (isLegacy(hint) || seen.has(key)) hidden.push(hint);
    else visible.push(hint);
    seen.add(key);
  }
  return {
    visible, hidden,
    different: new Set(hints.map(hint => normalizeWakeHintContent(hint.content))).size,
    shownThisWeek: hints.filter(hint => hint.usageCount > 0 && hint.lastUsed >= now - WEEK_MS).length,
  };
}

function isLegacy(hint: WakeHint): boolean {
  return hint.createdAt < LEGACY_CUTOFF && hint.lastUsed < LEGACY_CUTOFF;
}
