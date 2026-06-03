/**
 * Composer Toolbar Component
 *
 * Compact toolbar shown in the live-instance input panel above the textarea.
 * Provides:
 *   (a) Context-usage ring — small circular SVG indicator of context window % used
 *   (b) Model picker — reuses CompactModelPickerComponent in pending-create mode
 *   (c) Effort selector — 3-state control for low / medium / high reasoning effort
 *
 * Model changes call orchestrationIpc.changeModel() directly (per-instance IPC),
 * which is the same call the instance-header uses. Per-message model switching is
 * not a distinct backend concept; this wires to the per-instance changeModel.
 *
 * Effort selection is held as local signal state and emitted via (effortChange) so
 * the parent can attach it to the next sendMessage call if desired.  The current
 * backend does not accept a per-message effort override in sendInput, so the
 * toolbar also calls changeModel(model, effort) to propagate the effort selection
 * to the running instance immediately.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import { InstanceIpcService } from '../../core/services/ipc';
import type { ContextUsage } from '../../core/state/instance/instance.types';
import type { InstanceProvider } from '../../core/state/instance/instance.types';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import type { ReasoningEffort } from '../../../../shared/types/provider.types';
import { DEFAULT_INSTANCE_PROVIDERS } from '../models/provider-menu.component';

/** The three effort tiers surfaced in the toolbar. */
export type ToolbarEffort = 'low' | 'medium' | 'high';

const EFFORT_REASONING_MAP: Record<ToolbarEffort, ReasoningEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

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

      <!-- (c) Effort selector -->
      <div class="effort-group" role="group" aria-label="Reasoning effort">
        @for (tier of effortTiers; track tier.value) {
          <button
            type="button"
            class="effort-btn"
            [class.effort-btn--active]="selectedEffort() === tier.value"
            (click)="onEffortClick(tier.value)"
            [title]="tier.title"
          >
            {{ tier.label }}
          </button>
        }
      </div>
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

    /* ── Effort selector ── */
    .effort-group {
      display: inline-flex;
      gap: 0;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 13px;
      overflow: hidden;
      margin-left: auto;
    }

    .effort-btn {
      padding: 3px 9px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font: 11px var(--font-mono, monospace);
      font-weight: 500;
      cursor: pointer;
      text-transform: lowercase;
      letter-spacing: 0.04em;
      transition: background 0.15s, color 0.15s;

      &:hover {
        background: rgba(255, 255, 255, 0.05);
        color: var(--text-secondary);
      }

      &.effort-btn--active {
        background: rgba(var(--primary-rgb), 0.18);
        color: var(--primary-color);
      }
    }

    .effort-btn + .effort-btn {
      border-left: 1px solid rgba(255, 255, 255, 0.07);
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

  /** Emitted whenever the user changes effort. */
  effortChange = output<ToolbarEffort>();

  /** Provider list for the picker — same wide list used by new-session. */
  readonly pickerProviders = DEFAULT_INSTANCE_PROVIDERS;

  readonly effortTiers: { value: ToolbarEffort; label: string; title: string }[] = [
    { value: 'low',    label: 'low',    title: 'Low reasoning effort' },
    { value: 'medium', label: 'med',    title: 'Medium reasoning effort' },
    { value: 'high',   label: 'high',   title: 'High reasoning effort' },
  ];

  /** Holds the user's pending selection in the picker. Initialised in ngOnInit. */
  readonly pendingSelection = signal<PendingSelection | null>(null);

  readonly selectedEffort = signal<ToolbarEffort>('medium');

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

    const reasoningEffort = sel.reasoning
      ? sel.reasoning
      : (EFFORT_REASONING_MAP[this.selectedEffort()] as ReasoningEffort);

    await this.ipc.changeModel(this.instanceId(), sel.model, reasoningEffort);
  }

  async onEffortClick(effort: ToolbarEffort): Promise<void> {
    this.selectedEffort.set(effort);
    this.effortChange.emit(effort);

    // Propagate the effort change to the running instance if a model is known.
    const model = this.pendingSelection()?.model ?? this.currentModel();
    if (!model) return;

    await this.ipc.changeModel(
      this.instanceId(),
      model,
      EFFORT_REASONING_MAP[effort],
    );
  }
}
