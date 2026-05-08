import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LoopStore } from '../../core/state/loop.store';

@Component({
  selector: 'app-loop-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="loop-toggle" [class.disabled]="!canInteract()" [class.on]="visuallyOn()" [title]="title()">
      <span class="lt-icon" aria-hidden="true">🔁</span>
      <span class="lt-label">Loop</span>
      <span class="lt-switch" [class.on]="visuallyOn()">
        <input
          type="checkbox"
          [checked]="visuallyOn()"
          [disabled]="!canInteract()"
          (change)="onChange($event)"
        />
        <span class="lt-track"></span>
        <span class="lt-thumb"></span>
      </span>
    </label>
  `,
  styles: [`
    .loop-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.09);
      background: rgba(255, 255, 255, 0.035);
      color: var(--text-muted, inherit);
      font-size: 11px;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }
    .loop-toggle:hover:not(.disabled) {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
    }
    .loop-toggle.disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .lt-icon { font-size: 12px; line-height: 1; }
    .lt-label { letter-spacing: 0.04em; text-transform: uppercase; font-size: 10px; }

    .lt-switch {
      position: relative;
      display: inline-block;
      width: 26px;
      height: 14px;
      flex-shrink: 0;
    }
    .lt-switch input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      margin: 0;
      cursor: inherit;
    }
    .lt-track {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.16);
      transition: background 0.18s ease;
    }
    .lt-thumb {
      position: absolute;
      top: 1px;
      left: 1px;
      width: 12px;
      height: 12px;
      background: #fff;
      border-radius: 50%;
      transition: transform 0.18s ease;
      pointer-events: none;
    }
    .lt-switch.on .lt-track { background: var(--primary-color, #d4b45a); }
    .lt-switch.on .lt-thumb { transform: translateX(12px); }
  `],
})
export class LoopToggleComponent {
  chatId = input<string | null>(null);
  workspaceCwd = input<string | null>(null);
  hasTypedText = input<boolean>(false);
  panelOpen = input<boolean>(false);

  openConfig = output<void>();
  stopRequested = output<void>();

  protected store = inject(LoopStore);

  private active = computed(() => {
    const id = this.chatId();
    return id ? this.store.activeForChat(id)() : undefined;
  });

  isActive = computed(() => !!this.active());

  visuallyOn = computed(() => this.isActive() || this.panelOpen());

  canInteract = computed(() => {
    if (this.isActive()) return true;
    if (!this.workspaceCwd()) return false;
    return !!this.chatId() || this.hasTypedText();
  });

  title = computed(() => {
    if (this.isActive()) return 'Loop ON — click to stop';
    if (!this.workspaceCwd()) return 'Pick a working folder to enable Loop Mode';
    if (!this.chatId() && !this.hasTypedText()) return 'Type a prompt to enable Loop Mode';
    return 'Click to configure and start an autonomous loop';
  });

  constructor() {
    this.store.ensureWired();
  }

  onChange(event: Event): void {
    const wantOn = (event.target as HTMLInputElement).checked;
    if (this.isActive() && !wantOn) {
      this.stopRequested.emit();
    } else if (!this.isActive() && wantOn) {
      this.openConfig.emit();
    }
    // Force-sync the checkbox to authoritative state — Angular re-renders [checked]
    // on the next tick, but the DOM event has already mutated it.
    queueMicrotask(() => {
      (event.target as HTMLInputElement).checked = this.visuallyOn();
    });
  }
}
