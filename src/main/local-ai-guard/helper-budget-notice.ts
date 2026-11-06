import type { LocalAiHelperBudgetStatus } from '../../shared/types/local-ai-guard.types';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getNotificationService } from '../notifications/notification-service';

/** Live chip state with a durable once-per-UTC-day notification claim. */
export class HelperBudgetNotice {
  private state?: LocalAiHelperBudgetStatus;
  private notifiedDay = '';
  private expiry?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly changed: () => void) {}

  get snapshot(): LocalAiHelperBudgetStatus | undefined {
    this.refresh();
    return this.state ? { ...this.state } : undefined;
  }

  record(): void {
    if (this.disposed) return;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.notifiedDay === day) return;
    this.notifiedDay = day;
    this.state = {
      blockedAt: now,
      resetsAt: Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(),
        new Date(now).getUTCDate() + 1),
    };
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.refresh(), this.state.resetsAt - now);
    this.expiry.unref?.();
    try {
      const claim = getRLMDatabase().getRawDb().prepareCached(`
        INSERT INTO local_ai_helper_budget_notice (singleton, day) VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET day = excluded.day
        WHERE local_ai_helper_budget_notice.day < excluded.day
      `).run(day);
      if (claim.changes > 0) getNotificationService().notify({
        kind: 'local-ai-helper-daily-limit',
        title: 'Helper models: daily limit reached',
        body: 'Helper models: daily limit reached. Paid fallbacks resume tomorrow.',
        fingerprintFields: { day },
      });
    } catch {
      // A claim or delivery failure cannot change a denied authorization.
    }
    this.changed();
  }

  refresh(): void {
    if (this.disposed || !this.state || this.state.resetsAt > Date.now()) return;
    this.state = undefined;
    clearTimeout(this.expiry);
    this.expiry = undefined;
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.expiry);
    this.expiry = undefined;
    this.state = undefined;
  }
}
