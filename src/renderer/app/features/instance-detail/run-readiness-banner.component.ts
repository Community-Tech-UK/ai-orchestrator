/**
 * WS-C3 run-readiness checkpoint — the compact banner rendered near Send, plus
 * the tiny gate that feeds it and `InputPanelComponent.canSend()`.
 *
 * Split into two exports so `InputPanelComponent` (at its LOC ceiling) needs
 * only one import and one field:
 *
 * - `RunReadinessGate` sources the one signal this checkpoint currently
 *   aggregates (provider CLI health) and exposes `reasons`/`blocking`
 *   signals via the pure builder in `run-readiness.ts`.
 * - `RunReadinessBannerComponent` is a dumb renderer over `reasons` — it
 *   renders nothing when the list is empty, never as a modal, and gives
 *   each reason exactly one primary action plus (for non-blocking reasons
 *   only) a dismiss control.
 */
import {
  ChangeDetectionStrategy,
  Component,
  Signal,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import type { InstanceProvider } from '../../core/state/instance/instance.types';
import type { StartupCapabilityReport } from '../../../../shared/types/startup-capability.types';
import { buildRunReadinessReasons, type RunReadinessReason } from './run-readiness';

/**
 * Owns the WS-C3 IPC plumbing: a one-shot pull of the app-wide startup-
 * capabilities report, the same call `AppComponent` and `SetupCenterComponent`
 * already make independently (`AppIpcService.getStartupCapabilities()`) — no
 * new IPC channel. A one-shot pull (rather than also subscribing to
 * `onStartupCapabilities` push updates) keeps this dependency-free to
 * dispose: a composer that outlives a later re-probe simply reflects the
 * report as of when it mounted, and remounting (switching instances) picks
 * up anything newer.
 */
export class RunReadinessGate {
  private readonly appIpc = inject(AppIpcService);
  private readonly startupCapabilities = signal<StartupCapabilityReport | null>(null);

  constructor(private readonly provider: Signal<InstanceProvider>) {
    void this.appIpc.getStartupCapabilities().then((report) => {
      if (report) this.startupCapabilities.set(report);
    });
  }

  readonly reasons = computed<RunReadinessReason[]>(() =>
    buildRunReadinessReasons({
      provider: this.provider(),
      startupCapabilities: this.startupCapabilities(),
    }),
  );

  readonly blocking = computed(() => this.reasons().some((reason) => reason.severity === 'blocking'));
}

@Component({
  selector: 'app-run-readiness-banner',
  standalone: true,
  template: `
    @if (visibleReasons().length > 0) {
      <div class="run-readiness-banner">
        @for (reason of visibleReasons(); track reason.id) {
          <div
            class="run-readiness-item"
            [class.blocking]="reason.severity === 'blocking'"
            [class.warning]="reason.severity === 'warning'"
            [attr.role]="reason.severity === 'blocking' ? 'alert' : 'status'"
          >
            <span class="run-readiness-text">{{ reason.message }}</span>
            <div class="run-readiness-actions">
              @if (reason.action; as action) {
                <button
                  type="button"
                  class="run-readiness-btn"
                  [attr.aria-label]="action.label"
                  (click)="onAction(action.commandId)"
                >{{ action.label }}</button>
              }
              @if (reason.severity !== 'blocking') {
                <button
                  type="button"
                  class="run-readiness-btn run-readiness-btn--secondary"
                  aria-label="Dismiss"
                  title="Dismiss"
                  (click)="onDismiss(reason.id)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: `
    .run-readiness-banner {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 8px;
    }

    .run-readiness-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 8px;
      background: var(--surface-sunken-bg, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
      font-size: 12px;
      color: var(--text-secondary);

      &.warning {
        border-color: rgba(234, 179, 8, 0.3);
        color: var(--warning-color, #eab308);
      }

      &.blocking {
        border-color: rgba(239, 68, 68, 0.4);
        color: var(--error-color, #ef4444);
      }
    }

    .run-readiness-text {
      flex: 1;
      min-width: 0;
    }

    .run-readiness-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .run-readiness-btn {
      font-size: 11px;
      padding: 2px 10px;
      border-radius: 5px;
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
      background: transparent;
      color: inherit;
      cursor: pointer;

      &:hover {
        background: var(--hover-bg, rgba(255, 255, 255, 0.06));
      }

      &.run-readiness-btn--secondary {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        opacity: 0.7;

        &:hover {
          opacity: 1;
        }
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunReadinessBannerComponent {
  private readonly actionDispatch = inject(ActionDispatchService);

  instanceId = input.required<string>();
  reasons = input<RunReadinessReason[]>([]);

  /** Per-instance, in-memory only (per plan: "not persisted unless a natural mechanism exists"). */
  private readonly dismissedByInstance = new Map<string, Set<string>>();
  private readonly dismissedVersion = signal(0);

  readonly visibleReasons = computed<RunReadinessReason[]>(() => {
    this.dismissedVersion();
    const dismissed = this.dismissedByInstance.get(this.instanceId());
    // Blocking reasons are never dismissible — they explain why Send stays disabled.
    return this.reasons().filter((reason) => reason.severity === 'blocking' || !dismissed?.has(reason.id));
  });

  onAction(commandId: string): void {
    void this.actionDispatch.dispatch(commandId);
  }

  onDismiss(reasonId: string): void {
    const id = this.instanceId();
    const set = this.dismissedByInstance.get(id) ?? new Set<string>();
    set.add(reasonId);
    this.dismissedByInstance.set(id, set);
    this.dismissedVersion.update((v) => v + 1);
  }
}
