import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  HostListener,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { SessionNavigator } from '../../core/services/session-navigator.service';
import { NotificationCenterStore } from '../../core/state/notification-center.store';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { SettingsStore } from '../../core/state/settings.store';
import type { NotificationRecord } from '../../../../shared/types/notification.types';
import { TOOL_LOOP_CONTINUE_CONSEQUENCE } from '../../../../shared/tool-loop-summary';

@Component({
  selector: 'app-notification-center',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="notification-center-trigger"
      [attr.aria-expanded]="open()"
      aria-controls="notification-center-panel"
      appTooltip="Open notification center"
      (click)="toggle()"
    >
      Notifications
      @if (store.count() > 0) {
        <span class="notification-center-count">{{ store.count() > 99 ? '99+' : store.count() }}</span>
      }
    </button>

    @if (open()) {
      <section id="notification-center-panel" class="notification-center-panel" aria-label="Notification center">
        <header>
          <span>Notifications</span>
          @if (store.records().length > 0) {
            <button type="button" class="notification-center-clear" appTooltip="Clear all notifications" (click)="clearAll()">
              Clear all notifications
            </button>
          }
        </header>
        @if (store.records().length === 0) {
          <p class="notification-center-empty">No notifications yet.</p>
        } @else {
          <ol>
            @for (record of store.records().slice(0, 10); track record.id) {
              <li [class.critical]="record.urgency === 'critical'">
                <div class="notification-center-item-body">
                  @if (record.instanceId) {
                    <button type="button" class="notification-session" (click)="openSession(record)">
                      <strong>{{ record.title }}</strong><span [id]="'notification-body-' + record.id">{{ record.body }}</span>
                    </button>
                  } @else {
                    <strong>{{ record.title }}</strong><span>{{ record.body }}</span>
                  }
                  @if (record.repeatCount && record.repeatCount > 1) { <span>×{{ record.repeatCount }}</span> }
                  @if (record.resolvedAt !== undefined) { <span class="resolved">Resolved</span> }
                  @if (showToolLoopActions(record)) {
                    <div class="notification-center-actions">
                      <button
                        type="button"
                        class="notification-center-action"
                        [attr.aria-describedby]="'notification-body-' + record.id"
                        [disabled]="isStopping(record)"
                        (click)="stopTurn(record)"
                      >{{ isStopping(record) ? 'Stopping…' : 'Stop this turn' }}</button>
                      <button
                        type="button"
                        class="notification-center-action"
                        [attr.aria-describedby]="'notification-body-' + record.id"
                        [disabled]="isStopping(record)"
                        (click)="letContinue(record)"
                      >Let it continue</button>
                      @if (!autoInterruptOn()) {
                        <button
                          type="button"
                          class="notification-center-action"
                          (click)="enableAutoInterrupt()"
                        >Turn on auto-interrupt</button>
                      }
                    </div>
                    <span>{{ continueConsequence }}</span>
                    @if (stopErrorFor(record); as message) { <span class="notification-center-error" role="alert">{{ message }}</span> }
                  }
                </div>
                <button
                  type="button"
                  class="notification-center-dismiss"
                  [attr.aria-label]="'Dismiss ' + record.title"
                  appTooltip="Dismiss"
                  (click)="dismiss(record.id)"
                >
                  Dismiss
                </button>
              </li>
            }
          </ol>
        }
      </section>
    }
  `,
  styles: [`
    :host { display: inline-flex; position: relative; }
    .notification-center-trigger {
      align-items: center;
      background: var(--bg-elevated);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-full);
      color: var(--text-primary);
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      font-size: var(--text-xs);
      font-weight: 700;
      gap: 0.35rem;
      min-height: 24px;
      padding: 0 0.55rem;
      white-space: nowrap;
    }
    .notification-center-trigger:hover { background: var(--glass-strong); }
    .notification-center-count {
      align-items: center;
      background: var(--primary-color);
      border-radius: var(--radius-full);
      color: var(--on-primary, #fff);
      display: inline-flex;
      font-size: 0.65rem;
      justify-content: center;
      min-width: 1.1rem;
      padding: 0.05rem 0.25rem;
    }
    .notification-center-panel {
      background: var(--bg-elevated);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-md);
      color: var(--text-primary);
      max-height: min(28rem, calc(100vh - 4rem));
      overflow: auto;
      padding: 0.6rem;
      position: absolute;
      right: 0;
      top: calc(100% + 0.5rem);
      width: min(22rem, calc(100vw - 2rem));
    }
    header {
      align-items: center;
      display: flex;
      font-size: var(--text-sm);
      font-weight: 700;
      gap: 0.5rem;
      justify-content: space-between;
      margin: 0 0 0.45rem;
    }
    .notification-center-clear {
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      cursor: pointer;
      font: inherit;
      font-size: var(--text-xs);
      font-weight: 600;
      padding: 0.1rem 0.4rem;
    }
    .notification-center-clear:hover { background: var(--glass-strong); color: var(--text-primary); }
    ol { display: grid; gap: 0.35rem; list-style: none; margin: 0; padding: 0; }
    li {
      align-items: start;
      border-top: 1px solid var(--border-color);
      display: flex;
      gap: 0.5rem;
      justify-content: space-between;
      padding: 0.45rem 0;
    }
    li:first-child { border-top: 0; padding-top: 0; }
    .notification-session { display: grid; gap: 0.15rem; padding: 0; background: transparent; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .notification-session:focus-visible { outline: 2px solid var(--primary-color); }
    .resolved { color: var(--text-muted); }
    .notification-center-item-body { display: grid; gap: 0.15rem; min-width: 0; }
    li.critical strong { color: var(--error-color, #ef4444); }
    li span, .notification-center-empty { color: var(--text-secondary); font-size: var(--text-xs); margin: 0; }
    .notification-center-dismiss {
      background: transparent;
      border: 0;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      cursor: pointer;
      flex: none;
      font-size: var(--text-xs);
      line-height: 1;
      padding: 0.2rem 0.35rem;
    }
    .notification-center-dismiss:hover { background: var(--glass-strong); color: var(--text-primary); }
    .notification-center-actions { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.35rem; }
    .notification-center-action:disabled { cursor: default; opacity: 0.6; }
    li span.notification-center-error { color: var(--error-color); }
    .notification-center-action {
      background: var(--bg-elevated);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm, 4px);
      color: var(--text-primary);
      cursor: pointer;
      font-size: var(--text-xs);
      padding: 0.2rem 0.5rem;
    }
    .notification-center-action:hover { background: var(--glass-strong); }
  `],
})
export class NotificationCenterComponent implements OnInit {
  protected readonly store = inject(NotificationCenterStore);
  private readonly navigator = inject(SessionNavigator);
  private readonly toolLoopAlerts = inject(ToolLoopAlertStore);
  private readonly settings = inject(SettingsStore);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly open = signal(false);
  protected readonly continueConsequence = TOOL_LOOP_CONTINUE_CONSEQUENCE;
  /** Keyed by the alert (session and detection time), so a later alert never shows an old failure. */
  private readonly stopError = signal<{ instanceId: string; detectedAt: number; text: string } | null>(null);

  constructor() {
    effect(() => {
      if (this.open()) void this.store.markSeen({ ids: this.store.records().slice(0, 10).map(record => record.id) });
    });
  }

  protected openSession(record: NotificationRecord): void {
    if (!record.instanceId) return;
    this.navigator.openSession(record.instanceId);
    this.store.markSessionSeen(record.instanceId);
    this.open.set(false);
  }

  ngOnInit(): void {
    this.store.init();
  }

  protected toggle(): void {
    this.open.update((open) => !open);
  }

  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (!this.open()) return;
    const target = event.target;
    if (target instanceof Node && this.elementRef.nativeElement.contains(target)) return;
    this.open.set(false);
  }

  /**
   * N2 — a stored notification carries frozen text. Gating the actions on the
   * LIVE alert rather than on the record's own body is the point: once the loop
   * has resolved, "Stop this turn" would be offering to interrupt a turn that
   * already ended, and the body's promise ("it will keep going") is no longer
   * true. The auto-interrupt setting does not hide them: it never stops a
   * read-only tool, and it only acts when a detection fires, so a live alert is
   * still a live decision. When Harness does stop the turn, the alert clears.
   */
  protected showToolLoopActions(record: NotificationRecord): boolean {
    return record.kind === 'tool-loop' && record.instanceId !== undefined
      && this.latestToolLoopRecordIds().get(record.instanceId) === record.id
      && this.toolLoopAlerts.hasCriticalAlert(record.instanceId);
  }

  /**
   * The newest tool-loop record per session. Only that one offers the choice:
   * older records describe earlier detections, and buttons on them would act on
   * the current one.
   */
  private readonly latestToolLoopRecordIds = computed(() => {
    const latest = new Map<string, NotificationRecord>();
    for (const record of this.store.records()) {
      if (record.kind !== 'tool-loop' || !record.instanceId) continue;
      const current = latest.get(record.instanceId);
      if (!current || (record.updatedAt ?? record.createdAt) > (current.updatedAt ?? current.createdAt)) latest.set(record.instanceId, record);
    }
    return new Map([...latest].map(([instanceId, record]) => [instanceId, record.id]));
  });

  protected autoInterruptOn(): boolean {
    return this.settings.settings().toolLoopAutoInterrupt === true;
  }

  protected isStopping(record: NotificationRecord): boolean {
    return this.toolLoopAlerts.isStopping(record.instanceId);
  }

  protected stopErrorFor(record: NotificationRecord): string | null {
    const state = this.stopError();
    const alert = this.toolLoopAlerts.alertFor(record.instanceId);
    return state && alert && state.instanceId === alert.instanceId && state.detectedAt === alert.detectedAt ? state.text : null;
  }

  /** Same as Stop in the session; a successful stop clears the alert, which hides these actions. */
  protected async stopTurn(record: NotificationRecord): Promise<void> {
    const alert = this.toolLoopAlerts.alertFor(record.instanceId);
    if (!alert) return;
    const { instanceId, detectedAt } = alert;
    this.stopError.set(null);
    const failed = { instanceId, detectedAt, text: 'Could not stop this turn. Open the session and use Stop.' };
    try {
      if (!await this.toolLoopAlerts.stopTurn(instanceId)) this.stopError.set(failed);
    } catch {
      this.stopError.set(failed);
    }
  }

  /** The operator has decided; keeping the alert would keep asking. */
  protected letContinue(record: NotificationRecord): void {
    if (!record.instanceId) return;
    this.stopError.set(null);
    this.toolLoopAlerts.letContinue(record.instanceId);
  }

  protected enableAutoInterrupt(): void {
    void this.settings.update({ toolLoopAutoInterrupt: true });
  }

  protected dismiss(id: string): void {
    void this.store.dismiss(id);
  }

  protected clearAll(): void {
    void this.store.clearAll();
  }
}
