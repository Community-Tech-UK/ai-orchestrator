/**
 * The one menu that changes how a session behaves: mode, Auto-approve, Fast and
 * Computer Use. The header shows a chip for each of these only while it is not
 * its normal value; this menu is where each one is changed.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import type { Instance } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { agentModeName } from './instance-header-presentation';
import { SessionComputerUseControlComponent } from './session-computer-use-control.component';

/** The order the mode switch steps through; `instance-detail` cycles the same way. */
const MODE_AFTER = { Build: 'Plan', Plan: 'Review', Review: 'Build' } as const;

@Component({
  selector: 'app-session-options-menu',
  standalone: true,
  imports: [SessionComputerUseControlComponent, AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button #trigger type="button" class="trigger" aria-label="Session options" aria-haspopup="dialog" appTooltip="Session options"
      [attr.aria-expanded]="open()" (click)="open.set(!open())" (keydown.escape)="close($event, trigger)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" />
      </svg>
    </button>
    @if (open()) {
      <button type="button" class="backdrop" data-ui-hints-exempt="backdrop" aria-label="Close Session options" (click)="open.set(false); trigger.focus()"></button>
      <section class="options" role="dialog" aria-label="Session options" (keydown.escape)="close($event, trigger)">
        <div class="option">
          <button type="button" [disabled]="isChangingMode()" [appTooltipDisabledReason]="locked() ? copy('header.modeLocked') : null"
            (click)="!locked() && !isChangingMode() && cycleAgentMode.emit()">{{ isChangingMode() ? 'Changing…' : 'Mode: ' + modeName() }}</button>
          <small>Click to switch to {{ nextMode() }}</small>
        </div>
        <div class="option">
          <button type="button" [disabled]="isTogglingYolo()" [appTooltip]="yoloTooltip()" [appTooltipDisabledReason]="recovering() ? copy('header.yoloLocked') : null"
            (click)="!recovering() && !isTogglingYolo() && toggleYolo.emit()">{{ isTogglingYolo() ? 'Changing…' : 'Auto-approve: ' + (instance().yoloMode ? 'on' : 'off') }}</button>
          <small>Runs tools and edits without asking you</small>
          @if (yoloQueued(); as queued) { <small>{{ queued }}</small> }
          @if (yoloCostNote(); as note) { <small class="header-action-detail">{{ note }}</small> }
        </div>
        @if (supportsFast()) {
          <div class="option">
            <button type="button" [disabled]="isTogglingFastMode()" [appTooltip]="instance().fastMode ? copy('header.fastOn') : copy('header.fastOff')" [appTooltipDisabledReason]="locked() ? copy('header.fastLocked') : null"
              (click)="!locked() && !isTogglingFastMode() && toggleFastMode.emit()">{{ isTogglingFastMode() ? 'Changing…' : 'Fast: ' + (instance().fastMode ? 'on' : 'off') }}</button>
            <small>Faster replies at some capability cost</small>
          </div>
        }
        @if (settings().computerUseEnabled === true) {
          <div class="option">
            <app-session-computer-use-control [instance]="instance()" [compact]="true" />
            <small>Applies to the next call, no restart, this session only</small>
          </div>
        }
      </section>
    }
  `,
  styles: [`
    :host { position: relative; display: inline-flex; }
    button { font: inherit; color: inherit; background: transparent; border: 1px solid var(--border-color); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
    button[aria-disabled="true"], button:disabled { opacity: 0.5; cursor: not-allowed; }
    .trigger { display: inline-flex; align-items: center; border: none; padding: 0; color: var(--text-secondary); }
    .trigger:hover { color: var(--text-primary); }
    .options { position: absolute; right: 0; top: calc(100% + 8px); width: min(340px, 85vw); padding: 12px; background: var(--bg-elevated, #1d2126); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 10px; box-shadow: 0 8px 24px #0006; z-index: 1001; }
    .option { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-bottom: 12px; }
    .option:last-child { margin-bottom: 0; }
    small { color: var(--text-secondary); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
    .backdrop { position: fixed; inset: 0; border: 0; border-radius: 0; padding: 0; z-index: 1000; }
  `],
})
export class SessionOptionsMenuComponent {
  protected readonly copy = copyFor;
  private readonly settingsStore = inject(SettingsStore);

  readonly instance = input.required<Instance>();
  readonly isChangingMode = input(false);
  readonly isTogglingYolo = input(false);
  readonly isTogglingFastMode = input(false);
  /** What flipping Auto-approve would cost (the session restarts), when that is worth saying. */
  readonly yoloCostNote = input<string | null>(null);
  readonly cycleAgentMode = output<void>();
  readonly toggleYolo = output<void>();
  readonly toggleFastMode = output<void>();

  protected readonly open = signal(false);
  protected readonly settings = this.settingsStore.settings;
  /** The session is starting or recovering: nothing about it can change yet. */
  protected readonly recovering = computed(() => ['initializing', 'respawning', 'interrupting', 'cancelling', 'interrupt-escalating'].includes(this.instance().status));
  /** Also true mid-turn, when mode and Fast wait for the reply to finish. */
  protected readonly locked = computed(() => this.instance().status === 'busy' || this.recovering());
  protected readonly supportsFast = computed(() => ['claude', 'codex'].includes(this.instance().provider));
  protected readonly modeName = computed(() => agentModeName(this.instance().agentId));
  protected readonly nextMode = computed(() => MODE_AFTER[this.modeName()]);
  /** A queued Auto-approve flip keeps its arrow wording. */
  protected readonly yoloQueued = computed(() => {
    const { pendingYoloMode, yoloMode } = this.instance();
    return pendingYoloMode !== undefined && pendingYoloMode !== yoloMode ? `Auto-approve → ${pendingYoloMode ? 'on' : 'off'} after this reply` : null;
  });

  protected readonly yoloTooltip = computed(() => {
    const { pendingYoloMode, yoloMode } = this.instance();
    if (this.yoloQueued()) return pendingYoloMode ? copyFor('header.yoloPendingOn') : copyFor('header.yoloPendingOff');
    const note = this.yoloCostNote();
    return (yoloMode ? copyFor('header.yoloOn') : copyFor('header.yoloOff')) + (note ? '. ' + note : '');
  });

  protected close(event: Event, trigger: HTMLButtonElement): void {
    if (!this.open()) return;
    event.preventDefault();
    event.stopPropagation();
    this.open.set(false);
    trigger.focus();
  }
}
