import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { NotificationCenterStore } from '../../core/state/notification-center.store';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import type { NotificationRecord } from '../../../../shared/types/notification.types';

@Component({
  selector: 'app-notification-center',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="notification-center-trigger"
      [attr.aria-expanded]="open()"
      aria-controls="notification-center-panel"
      title="Open notification center"
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
            <button type="button" class="notification-center-clear" title="Clear all notifications" (click)="clearAll()">
              Clear all
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
                  <strong>{{ record.title }}</strong>
                  <span>{{ record.body }}</span>
                  @if (showToolLoopActions(record)) {
                    <div class="notification-center-actions">
                      <button
                        type="button"
                        class="notification-center-action"
                        (click)="interruptLoop(record)"
                      >Interrupt now</button>
                      <button
                        type="button"
                        class="notification-center-action"
                        (click)="enableAutoInterrupt()"
                      >Turn on auto-interrupt</button>
                    </div>
                  }
                </div>
                <button
                  type="button"
                  class="notification-center-dismiss"
                  [attr.aria-label]="'Dismiss ' + record.title"
                  title="Dismiss"
                  (click)="dismiss(record.id)"
                >
                  ✕
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
    .notification-center-actions { display: flex; gap: 0.35rem; margin-top: 0.35rem; }
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
  private readonly toolLoopAlerts = inject(ToolLoopAlertStore);
  private readonly instances = inject(InstanceStore);
  private readonly settings = inject(SettingsStore);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly open = signal(false);

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
   * has resolved, "Interrupt now" would be offering to interrupt a turn that
   * already ended, and the body's promise ("it will keep going") is no longer
   * true. Also hidden once auto-interrupt is on, for the same reason — the
   * consequence the record describes no longer applies.
   */
  protected showToolLoopActions(record: NotificationRecord): boolean {
    if (record.kind !== 'tool-loop') return false;
    if (this.settings.settings().toolLoopAutoInterrupt === true) return false;
    return this.toolLoopAlerts.hasCriticalAlert(record.instanceId);
  }

  protected interruptLoop(record: NotificationRecord): void {
    if (!record.instanceId) return;
    const instanceId = record.instanceId;
    void this.instances.interruptInstance(instanceId);
    // The operator has acted; keeping the alert would keep offering the action.
    this.toolLoopAlerts.acknowledge(instanceId);
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
