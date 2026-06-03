/**
 * Composer Toolbar Component
 *
 * Compact toolbar shown in the live-instance input panel above the textarea.
 * Provides:
 *   (a) Context-usage ring — small circular SVG indicator of context window % used
 *   (b) Model picker — reuses CompactModelPickerComponent in pending-create mode
 *
 * Reasoning effort is owned entirely by the model picker (it exposes the full,
 * provider-aware tier set per model and applies the provider default). The toolbar
 * no longer carries a separate low/med/high effort control — that duplicated the
 * picker's value with a fixed 3-tier vocabulary and a `medium` default that could
 * silently downgrade providers (e.g. Claude defaults to High).
 *
 * Model/effort changes call InstanceIpcService.changeModel() directly (per-instance
 * IPC), which is the same call the instance-header uses. Per-message model switching
 * is not a distinct backend concept; this wires to the per-instance changeModel,
 * which tears down and respawns the CLI with the new flags and resumes the session,
 * so conversation context is preserved.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import { InstanceIpcService } from '../../core/services/ipc';
import type { ContextUsage } from '../../core/state/instance/instance.types';
import type { InstanceProvider } from '../../core/state/instance/instance.types';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import { DEFAULT_INSTANCE_PROVIDERS } from '../models/provider-menu.component';

/** Circumference of the SVG ring (r=8, so C ≈ 50.27). */
const RING_CIRCUMFERENCE = 2 * Math.PI * 8;

@Component({
  selector: 'app-composer-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CompactModelPickerComponent, DecimalPipe],
  template: `
    <div class="composer-toolbar-row">
      <!-- (a) Context ring -->
      <button
        type="button"
        class="ctx-ring-btn"
        [title]="ringTitle()"
        [attr.aria-label]="ringTitle()"
        tabindex="-1"
      >
        <svg
          class="ctx-ring"
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
        >
          <circle
            class="ctx-ring__track"
            cx="10" cy="10" r="8"
            stroke-width="2.5"
            stroke-linecap="round"
          />
          <circle
            class="ctx-ring__fill"
            [class.ctx-ring__fill--warning]="ringPct() > 70"
            [class.ctx-ring__fill--danger]="ringPct() > 90"
            cx="10" cy="10" r="8"
            stroke-width="2.5"
            stroke-linecap="round"
            [attr.stroke-dasharray]="ringDash()"
            [attr.stroke-dashoffset]="ringOffset()"
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span class="ctx-ring__label">{{ ringPct() | number:'1.0-0' }}%</span>
      </button>

      <!-- (b) Model picker -->
      @if (pickerSelection()) {
        <app-compact-model-picker
          mode="pending-create"
          [providers]="pickerProviders"
          [selection]="pickerSelection()!"
          (selectionChange)="onPickerSelectionChange($event)"
        />
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .composer-toolbar-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      margin-bottom: 10px;
      flex-wrap: wrap;
    }

    /* ── Context ring ── */
    .ctx-ring-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 6px 0 2px;
      background: transparent;
      border: none;
      cursor: default;
      color: var(--text-muted);
    }

    .ctx-ring__track {
      stroke: rgba(255, 255, 255, 0.08);
    }

    .ctx-ring__fill {
      stroke: var(--secondary-color, #789482);
      transition: stroke-dashoffset 0.4s ease, stroke 0.3s ease;
    }

    .ctx-ring__fill--warning {
      stroke: var(--warning-color, #eab308);
    }

    .ctx-ring__fill--danger {
      stroke: var(--error-color, #ef4444);
    }

    .ctx-ring__label {
      font: 10px var(--font-mono, monospace);
      color: var(--text-muted);
      min-width: 26px;
      letter-spacing: 0.02em;
    }
  `],
})
export class ComposerToolbarComponent implements OnInit {
  private readonly ipc = inject(InstanceIpcService);

  /** Instance ID — used to call changeModel IPC. */
  instanceId = input.required<string>();

  /** Context usage from the running instance. When absent, ring shows 0%. */
  contextUsage = input<ContextUsage | undefined>(undefined);

  /** Current provider for the instance (drives picker initial state). */
  provider = input<InstanceProvider>('claude');

  /** Current model for the instance (drives picker initial state). */
  currentModel = input<string | undefined>(undefined);

  /** Provider list for the picker — same wide list used by new-session. */
  readonly pickerProviders = DEFAULT_INSTANCE_PROVIDERS;

  /** Holds the user's pending selection in the picker. Initialised in ngOnInit. */
  readonly pendingSelection = signal<PendingSelection | null>(null);

  // ── Computed for the ring ──

  readonly ringPct = computed(() => {
    const u = this.contextUsage();
    if (!u || u.total === 0) return 0;
    return Math.min((u.used / u.total) * 100, 100);
  });

  readonly ringDash = computed(() => {
    const used = (this.ringPct() / 100) * RING_CIRCUMFERENCE;
    const gap = RING_CIRCUMFERENCE - used;
    return `${used.toFixed(2)} ${gap.toFixed(2)}`;
  });

  /**
   * stroke-dashoffset is always 0 — the ring starts at the 12-o'clock position
   * via `transform="rotate(-90 10 10)"` on the element. We only need dasharray.
   */
  readonly ringOffset = computed(() => 0);

  readonly ringTitle = computed(() => {
    const u = this.contextUsage();
    if (!u) return 'Context window: no data';
    const pct = this.ringPct().toFixed(0);
    return `Context window: ${pct}% used (${u.used.toLocaleString()} / ${u.total.toLocaleString()} tokens)`;
  });

  readonly pickerSelection = computed<PendingSelection | null>(() => this.pendingSelection());

  ngOnInit(): void {
    // Seed the picker with the instance's current provider + model.
    const p = this.provider();
    const pickerProvider: PickerProvider = (p === 'ollama' ? 'claude' : p) as PickerProvider;
    this.pendingSelection.set({
      provider: pickerProvider,
      model: this.currentModel() ?? null,
      reasoning: null,
    });
  }

  async onPickerSelectionChange(sel: PendingSelection): Promise<void> {
    this.pendingSelection.set(sel);

    // Only send IPC when we have a real model selected.
    if (!sel.model) return;

    // Reasoning effort is owned by the picker. When the user didn't pick a
    // level (reasoning === null), pass undefined so the backend preserves the
    // instance's current effort rather than forcing a default.
    const reasoningEffort = sel.reasoning ?? undefined;

    await this.ipc.changeModel(this.instanceId(), sel.model, reasoningEffort);
  }
}
