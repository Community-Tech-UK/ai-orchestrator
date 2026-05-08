import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LoopStore } from '../../core/state/loop.store';

@Component({
  selector: 'app-loop-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label
      class="loop-toggle"
      [class.disabled]="!canInteract()"
      [class.armed]="panelOpen() && !isActive()"
      [class.running]="isActive()"
      [title]="title()"
    >
      <span class="lt-icon" aria-hidden="true">{{ isActive() ? '⏵' : '🔁' }}</span>
      <span class="lt-label">{{ isActive() ? 'Loop running' : (panelOpen() ? 'Loop armed' : 'Loop') }}</span>
      <span class="lt-switch" [class.armed]="panelOpen() && !isActive()" [class.running]="isActive()">
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
    .lt-switch.armed .lt-track { background: var(--primary-color, #d4b45a); }
    .lt-switch.armed .lt-thumb { transform: translateX(12px); }
    /* "Running" gets a distinct green to make it unmistakable that a loop is
     * active vs. armed-but-not-yet-started. */
    .lt-switch.running .lt-track { background: #4eaa6a; }
    .lt-switch.running .lt-thumb { transform: translateX(12px); }
    .loop-toggle.running { border-color: rgba(78, 170, 106, 0.5); }
    .loop-toggle.running:hover:not(.disabled) { background: rgba(78, 170, 106, 0.12); }
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
    // Just need a working folder. The panel itself always has a prompt
    // (default canonical or recent), so a loop can start without textarea
    // content — the panel becomes both iter 0 and iter 1+ in that case.
    return !!this.workspaceCwd();
  });

  title = computed(() => {
    if (this.isActive()) return 'Loop ON — click to stop';
    if (this.panelOpen()) return 'Click to close the loop config panel';
    if (!this.workspaceCwd()) return 'Pick a working folder to enable Loop Mode';
    return 'Click to open the loop config panel';
  });

  constructor() {
    this.store.ensureWired();
  }

  onChange(event: Event): void {
    if (this.isActive()) {
      // Active loop → clicking the toggle is always a stop request.
      this.stopRequested.emit();
    } else {
      // No active loop → emit `openConfig`; the parent decides whether to
      // open or close the panel based on its current visibility. This way
      // the toggle is a single intent ("flip the panel"), not a checkbox.
      this.openConfig.emit();
    }
    // Force-sync the checkbox to authoritative state — Angular re-renders [checked]
    // on the next tick, but the DOM event has already mutated it.
    queueMicrotask(() => {
      (event.target as HTMLInputElement).checked = this.visuallyOn();
    });
  }
}
