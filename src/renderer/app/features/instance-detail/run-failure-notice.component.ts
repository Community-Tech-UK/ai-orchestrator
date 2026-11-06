import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { InstanceStore } from '../../core/state/instance';
import { RunFailureStateService, SAFE_CONTINUATION } from './run-failure-state.service';
import { UserInputRequestRegistry } from './user-input-request.registry';

@Component({
  selector: 'app-run-failure-notice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (failure(); as notice) {
      <aside class="failure-notice" role="status" aria-label="Turn stopped">
        <strong>{{ notice.presentation.headline }}</strong>
        <p>{{ notice.presentation.whatToDo }}</p>
        @if (notice.presentation.rawDetail) {
          <details><summary>Details</summary><pre>{{ notice.presentation.rawDetail }}</pre></details>
          <button type="button" (click)="copyError()">{{ copied() ? 'Copied' : 'Copy error' }}</button>
        }
        <button type="button" [disabled]="sending()" [attr.aria-disabled]="blockedReason() ? 'true' : null"
          [attr.aria-describedby]="blockedReason() ? 'retry-reason-' + instanceId() : null" (click)="retry()">
          {{ sending() ? 'Continuing…' : 'Try again' }}
        </button>
        @if (blockedReason(); as reason) { <p [id]="'retry-reason-' + instanceId()">{{ reason }}</p> }
        @if (sendFailed()) { <p>Couldn't send the continuation. Try again when this session is ready.</p> }
        @if (copyFailed()) { <p>Couldn't copy the error. You can select it in Details.</p> }
      </aside>
    }
  `,
  styles: `
    .failure-notice { padding: 12px; margin: 8px 0; border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-secondary); }
    p { margin: 6px 0; }
    button { margin: 8px 8px 0 0; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
  `,
})
export class RunFailureNoticeComponent {
  readonly instanceId = input.required<string>();
  private readonly failures = inject(RunFailureStateService);
  private readonly instances = inject(InstanceStore);
  private readonly questions = inject(UserInputRequestRegistry);
  protected readonly failure = computed(() => {
    const wait = this.instances.getInstance(this.instanceId())?.waitReason?.kind;
    return wait && ['backoff', 'quota-park', 'auth-required'].includes(wait)
      ? undefined : this.failures.forInstance(this.instanceId());
  });
  private readonly sendingFor = signal<string | null>(null);
  protected readonly sending = computed(() => this.sendingFor() === this.failure()?.id);
  protected readonly sendFailed = signal(false);
  protected readonly copied = signal(false);
  protected readonly copyFailed = signal(false);
  protected readonly blockedReason = computed(() => {
    const instance = this.instances.getInstance(this.instanceId());
    if (!instance) return 'This session is no longer available.';
    if (instance.status === 'terminated') return 'This session has ended. Start a new session to continue.';
    if (this.questions.hasWaitingQuestion(this.instanceId())) return 'Answer the waiting question before trying again.';
    if (instance.status === 'waiting_for_permission') return 'Respond to the approval request before trying again.';
    if (instance.waitReason) return 'This session is waiting. Try again when it is ready.';
    if (instance.activeTurnId || ['busy', 'running'].includes(instance.status)) return 'Wait for the current turn to finish before trying again.';
    if (['initializing', 'respawning', 'waking'].includes(instance.status)) return 'Wait for this session to be ready before trying again.';
    return null;
  });

  protected async retry(): Promise<void> {
    const notice = this.failure();
    if (!notice || this.sending() || this.blockedReason()) return;
    this.sendingFor.set(notice.id);
    this.sendFailed.set(false);
    try {
      await this.instances.sendInput(this.instanceId(), SAFE_CONTINUATION);
    } catch {
      if (this.failure()?.id === notice.id) this.sendFailed.set(true);
    } finally {
      if (this.sendingFor() === notice.id) this.sendingFor.set(null);
    }
  }

  protected async copyError(): Promise<void> {
    this.copyFailed.set(false);
    try {
      await navigator.clipboard.writeText(this.failure()?.presentation.rawDetail ?? '');
      this.copied.set(true);
    } catch {
      this.copyFailed.set(true);
    }
  }
}
