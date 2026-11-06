import type { TurnCaptureState, ThreadItem } from './app-server-types';
import type { CodexUsageAccounting } from './usage-accounting';
import type { CodexMeasureMode, CodexTurnCeilingController } from './codex-turn-ceiling-controller';

interface HelperWork { rootTurnId?: string; parent?: HelperWork; confirmed: boolean; pendingTokens: number }

/** Helper receipts stay with the root turn that launched the work, including after that root ends. */
export class CodexTurnUsageOwner {
  private rootTurnId: string | undefined;
  private readonly helpers = new Map<string, HelperWork>();
  private readonly helperTurns = new Map<string, HelperWork>();
  private readonly pending = new Set<HelperWork>();

  constructor(private readonly ceiling: CodexTurnCeilingController, private readonly rootThreadId: () => string | null, private readonly cumulativeTokens: () => number) {}

  beginRoot(turnId: string): void {
    this.rootTurnId = turnId;
    this.ceiling.beginTurn(turnId);
  }

  trackHelper(threadId: string, parentId = this.rootThreadId(), newWork = false, parentTurnId?: string): void {
    if (threadId === this.rootThreadId() || !newWork && this.helpers.has(threadId)) return;
    this.helpers.set(threadId, newWork ? this.workFromParent(parentId, parentTurnId) : { confirmed: false, pendingTokens: 0 });
    this.flushPending();
  }

  /** A delayed spawn receipt confirms the same work object held by native turns and descendants. */
  discoverHelper(threadId: string, parentId: string, parentTurnId?: string): void {
    if (threadId === this.rootThreadId() || threadId === parentId) return;
    const work = this.helpers.get(threadId);
    if (work?.confirmed) return;
    const origin = this.workFromParent(parentId, parentTurnId);
    if (work) { work.rootTurnId = origin.rootTurnId; work.parent = origin.parent; work.confirmed = origin.confirmed; }
    else this.helpers.set(threadId, origin);
    this.flushPending();
  }

  private workFromParent(threadId: string | null, nativeTurnId?: string): HelperWork {
    // A parent thread can be reused: only its native turn identifies which work spawned this helper.
    if (threadId === this.rootThreadId()) return { rootTurnId: nativeTurnId ?? this.rootTurnId, confirmed: nativeTurnId !== undefined, pendingTokens: 0 };
    const parent = threadId ? this.helperWork(threadId, nativeTurnId) : undefined;
    return { parent, confirmed: parent !== undefined && nativeTurnId !== undefined, pendingTokens: 0 };
  }

  private helperWork(threadId: string, nativeTurnId?: string): HelperWork {
    const native = nativeTurnId ? this.helperTurns.get(`${threadId}\0${nativeTurnId}`) : undefined;
    if (native) return native;
    let work = this.helpers.get(threadId);
    if (!work) { work = { confirmed: false, pendingTokens: 0 }; this.helpers.set(threadId, work); }
    return work;
  }

  private rootOf(work: HelperWork): string | undefined {
    const seen = new Set<HelperWork>();
    for (;;) {
      if (!work.confirmed || seen.has(work)) return undefined;
      seen.add(work);
      if (!work.parent) return work.rootTurnId;
      work = work.parent;
    }
  }

  private flushPending(): void {
    let liveOwner: string | undefined;
    for (const work of this.pending) {
      const owner = this.rootOf(work);
      if (!owner) continue;
      this.ceiling.recordMeasuredUsage(true, work.pendingTokens, 'late', owner);
      if (owner === this.rootTurnId) liveOwner = owner;
      work.pendingTokens = 0;
      this.pending.delete(work);
    }
    // Attribute the whole batch before acting; the controller knows whether this root is still live.
    if (liveOwner) this.ceiling.evaluateLiveTurn(liveOwner);
  }

  beginHelperTurn(threadId: string, turnId: string): void {
    if (!this.helpers.has(threadId)) this.trackHelper(threadId);
    const owner = this.helpers.get(threadId);
    if (owner) this.helperTurns.set(`${threadId}\0${turnId}`, owner);
  }

  measure(threadId: string, run: () => void, mode: CodexMeasureMode, nativeTurnId?: string): void {
    const helper = threadId !== this.rootThreadId();
    const work = helper ? this.helperWork(threadId, nativeTurnId) : undefined;
    const owner = work ? this.rootOf(work) : nativeTurnId ?? this.rootTurnId;
    if (!owner) {
      // Book provider spend immediately, retaining unattributed tokens until origin is proven.
      const before = this.cumulativeTokens();
      run();
      const delta = this.cumulativeTokens() - before;
      if (work && delta > 0) { work.pendingTokens += delta; this.pending.add(work); }
      return;
    }
    this.ceiling.measure(helper, run, mode === 'live' && owner === this.rootTurnId ? 'live' : 'late', owner);
  }

  trackItemChildren(state: TurnCaptureState | null, params: Record<string, unknown>, accounting: CodexUsageAccounting): void {
    const parentId = params['threadId'];
    if (parentId !== this.rootThreadId() && (typeof parentId !== 'string' || !accounting.ownsThread(parentId))) return;
    const item = params['item'] as ThreadItem | undefined;
    if (!item) return;
    const activityChild = item.type === 'subAgentActivity' || item.type === 'SubAgentActivity'
      ? item['agentThreadId'] ?? item['agent_thread_id'] : undefined;
    const ids = [activityChild, ...(item.type === 'collabAgentToolCall' ? item.receiverThreadIds ?? [] : [])];
    for (const id of ids) {
      if (typeof id !== 'string' || !id || id === this.rootThreadId()) continue;
      accounting.trackThread(id);
      state?.threadIds.add(id);
      // Observing or waiting on an old helper does not launch new work in this round.
      const parentTurnId = typeof params['turnId'] === 'string' ? params['turnId'] : undefined;
      // Codex 0.165.0 v2 spawn emits started activity on the spawning parent's native turn.
      if ((item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent')
        || (activityChild === id && item['kind'] === 'started')) this.discoverHelper(id, parentId as string, parentTurnId);
      else {
        const newWork = item.type === 'collabAgentToolCall'
          && ['sendInput', 'resumeAgent', 'sendMessage', 'followupTask'].includes(item.tool ?? '');
        this.trackHelper(id, parentId as string, newWork, parentTurnId);
      }
    }
  }
}
