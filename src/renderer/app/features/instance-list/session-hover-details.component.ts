import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import type { Instance } from '../../core/state/instance/instance.types';
import { PendingRequestStore } from '../../core/state/pending-request.store';
import { presentInstanceStatus } from '../../../../shared/attention/instance-status-presentation';
import { SessionTodoPeekService } from './session-todo-peek.service';
import { SessionHoverCardComponent } from './session-hover-card.component';

/** Instantiated by the tooltip portal only, keeping per-row polling at zero. */
@Component({
  selector: 'app-session-hover-details', standalone: true, imports: [SessionHoverCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-session-hover-card [name]="name() || instance().displayName" [status]="status()" [pendingText]="pendingText()" [step]="step()" />`,
})
export class SessionHoverDetailsComponent {
  readonly instance = input.required<Instance>();
  readonly name = input<string | null>(null);
  private readonly requests = inject(PendingRequestStore);
  private readonly todos = inject(SessionTodoPeekService);
  readonly pendingText = computed(() => this.requests.forInstance(this.instance().id)[0]?.text ?? null);
  /** A pending permission asks for a decision even while the session's own status says it is working. */
  readonly status = computed(() => presentInstanceStatus(
    this.instance().status !== 'waiting_for_input' && (this.instance().pendingApprovalCount ?? 0) > 0
      ? 'waiting_for_permission' : this.instance().status).label);
  readonly step = signal<string | null>(null);
  constructor() {
    effect((cleanup) => {
      const sessionId = this.instance().sessionId;
      let active = true;
      this.step.set(null);
      void this.todos.peek(sessionId).then((line) => { if (active) this.step.set(line); });
      cleanup(() => { active = false; });
    });
  }
}
