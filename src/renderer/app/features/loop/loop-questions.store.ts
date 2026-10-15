import { Injectable, DestroyRef, computed, inject, signal } from '@angular/core';
import type { LoopOutstandingItemPayload, LoopAnswerOutstandingPayload } from '@contracts/schemas/loop';
import { countsTowardNeedsYou, loopQuestionNeed } from '../../../../shared/attention/question-need';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';

export type QuestionDelivery = 'sent-to-loop' | 'saved-for-resume' | 'recorded';
/** Component-scoped state prevents two expanded loops sharing one query result. */
@Injectable()
export class LoopQuestionsStore {
  private readonly ipc = inject(LoopIpcService);
  private readonly rows = signal<LoopOutstandingItemPayload[]>([]);
  private readonly deliveries = signal<Record<string, QuestionDelivery>>({});
  private scope: { loopRunId: string; chatId: string } | null = null;
  private requestVersion = 0;
  readonly items = this.rows.asReadonly();
  readonly error = signal<string | null>(null);
  readonly pendingId = signal<string | null>(null);
  readonly waitingCount = computed(() => this.rows().filter(item => countsTowardNeedsYou({ ...item, userResponse: item.userResponse ?? null }) && loopQuestionNeed(item) === 'answer').length);
  readonly appliedCount = computed(() => this.rows().filter(item => countsTowardNeedsYou({ ...item, userResponse: item.userResponse ?? null }) && loopQuestionNeed(item) === 'applied').length);

  constructor() {
    const unsubscribe = this.ipc.onOutstandingChanged(event => {
      if (!this.scope) return;
      if (event.loopRunId === this.scope.loopRunId || (!event.loopRunId && event.itemId && this.rows().some(item => item.id === event.itemId))) void this.load(this.scope.loopRunId, this.scope.chatId);
    });
    inject(DestroyRef).onDestroy(unsubscribe);
  }
  async load(loopRunId: string, chatId: string): Promise<void> {
    this.scope = { loopRunId, chatId };
    const version = ++this.requestVersion;
    try {
      const response = await this.ipc.listOutstanding({ chatId, status: 'open', limit: 1000 });
      if (version !== this.requestVersion) return;
      if (response.success && response.data) { this.rows.set(response.data.items.filter(item => item.loopRunId === loopRunId)); this.error.set(null); }
      else this.error.set(response.error?.message ?? 'Could not load loop questions.');
    } catch (error) { if (version === this.requestVersion) this.error.set(error instanceof Error ? error.message : String(error)); }
  }
  deliveryFor(id: string): QuestionDelivery | null { return this.deliveries()[id] ?? null; }
  async answer(id: string, action: LoopAnswerOutstandingPayload['action'], response?: string, expectedRecommendation: string | null = null): Promise<void> {
    if (this.pendingId()) return;
    this.pendingId.set(id); this.error.set(null);
    try {
      const result = await this.ipc.answerOutstanding({ id, action, expectedRecommendation, ...(response !== undefined ? { response } : {}) });
      if (!result.success || !result.data?.ok) { this.error.set(result.error?.message ?? 'Could not save this answer.'); return; }
      this.deliveries.update(current => ({ ...current, [id]: result.data!.delivery }));
      if (this.scope) await this.load(this.scope.loopRunId, this.scope.chatId);
    } catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
    finally { this.pendingId.set(null); }
  }
}
