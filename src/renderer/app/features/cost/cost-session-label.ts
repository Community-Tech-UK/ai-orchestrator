interface LiveSession { id: string; sessionId: string; displayName: string; aiTitle?: string; isRenamed?: boolean }
interface HistorySession { id: string; sessionId?: string; originalInstanceId?: string; displayName: string; aiTitle?: string; isRenamed?: boolean }
export interface CostSessionLabel { title: string; state: 'open' | 'ended' | 'unknown'; target: string | null }
export function resolveCostSessionLabel(sessionId: string, instanceId: string | undefined,
  liveInstances: readonly LiveSession[], historyEntries: readonly HistorySession[]): CostSessionLabel {
  const live = liveInstances.find(i => i.id === instanceId) ?? liveInstances.find(i => i.sessionId === sessionId);
  if (live) return { title: live.displayName, state: 'open', target: live.id };
  const history = historyEntries.find(h => h.sessionId === sessionId) ?? historyEntries.find(h => instanceId && h.originalInstanceId === instanceId);
  if (history) return { title: history.isRenamed ? history.displayName : history.aiTitle || history.displayName, state: 'ended', target: history.id };
  return { title: 'Ended session', state: 'unknown', target: null };
}
