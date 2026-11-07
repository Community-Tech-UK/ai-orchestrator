export interface CacheMissSample { promptTokens: number; at: number; cacheRead?: number; cacheWrite?: number; model?: string; exact?: boolean }
export interface CacheMissAssessment { missedTokens: number; cause: string; idleMs: number }
export function assessCacheMiss(previous: CacheMissSample | undefined, current: CacheMissSample, notes: readonly string[], ttlMs?: number): CacheMissAssessment | null {
  if (!previous) return null;
  const shared = Math.min(previous.promptTokens, current.promptTokens);
  const missedTokens = Math.max(0, current.exact === false
    ? Math.min(previous.promptTokens, current.cacheWrite ?? 0) : shared - (current.cacheRead ?? 0));
  const idleMs = Math.max(0, current.at - previous.at);
  if (missedTokens <= 1024 || !Number.isFinite(missedTokens)) return null;
  if (!(ttlMs && idleMs > ttlMs) && (missedTokens < 2000 || missedTokens <= current.promptTokens * 0.05)) return null;
  const cause = notes.includes('after compaction') ? 'after compaction'
    : (previous.model && current.model && previous.model !== current.model) || notes.some(n => /model.*change/i.test(n)) ? 'model switch'
    : notes.some(n => /restart|respawn|wake/.test(n)) ? 'session restarted'
    : ttlMs && idleMs > ttlMs ? `idle ${Math.round(idleMs / 60000)} min`
    : notes.find(n => n.startsWith('settings change:')) ?? 'provider-side, nothing to fix';
  return { missedTokens, cause, idleMs };
}
