import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { AutomationStore } from '../../core/state/automation.store';
import { LoopStore } from '../../core/state/loop.store';
import type { Instance } from '../../core/state/instance/instance.types';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';
import { idleHintFor } from './idle-cache-hint';

/** Re-check once a minute; the hint only appears after 75 idle minutes. */
const TICK_MS = 60_000;

/**
 * A quiet suggestion above the composer for a large Claude session that has been left alone:
 * starting a new session skips re-reading everything. It never blocks anything and goes away
 * when dismissed or when the session is used again.
 */
@Component({
  selector: 'app-idle-cache-hint',
  standalone: true,
  imports: [AppIconButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (hint(); as text) {
      <div class="idle-cache-hint" role="status" data-testid="idle-cache-hint">
        <span class="idle-cache-hint-text">{{ text }}</span>
        <button
          type="button"
          class="idle-cache-hint-dismiss"
          appIconButton="Dismiss this suggestion"
          (click)="dismiss()"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    }
  `,
  styles: [`
    .idle-cache-hint {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-md);
      font-size: 13px;
      background: rgba(99, 102, 241, 0.08);
      border: 1px solid rgba(99, 102, 241, 0.25);
      color: var(--text-secondary);
    }

    .idle-cache-hint-text {
      min-width: 0;
    }

    .idle-cache-hint-dismiss {
      display: inline-flex;
      align-items: center;
      padding: 2px;
      border: none;
      border-radius: var(--radius-sm);
      background: transparent;
      color: inherit;
      cursor: pointer;
      flex-shrink: 0;
    }

    .idle-cache-hint-dismiss:hover {
      background: rgba(255, 255, 255, 0.1);
    }
  `],
})
export class IdleCacheHintComponent {
  private readonly automations = inject(AutomationStore);
  private readonly loops = inject(LoopStore);

  readonly instance = input.required<Instance>();

  private readonly now = signal(Date.now());
  /** `lastActivity` the person dismissed the hint for; using the session again makes it eligible again. */
  private readonly dismissedFor = signal<number | null>(null);

  private readonly hasScheduledWakeUp = computed(
    () => this.automations.threadWakeupsForInstance(this.instance().id).length > 0,
  );
  private readonly hasActiveLoop = computed(() => this.loops.activeForChat(this.instance().id)() !== undefined);

  readonly hint = computed<string | null>(() => {
    const instance = this.instance();
    if (this.dismissedFor() === instance.lastActivity) return null;
    const decision = idleHintFor({
      instance,
      hasScheduledWakeUp: this.hasScheduledWakeUp(),
      hasActiveLoop: this.hasActiveLoop(),
      now: this.now(),
    });
    return decision.show ? decision.text : null;
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  dismiss(): void {
    this.dismissedFor.set(this.instance().lastActivity);
  }
}
