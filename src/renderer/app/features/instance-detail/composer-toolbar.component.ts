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
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import { InstanceIpcService } from '../../core/services/ipc';
import type { ContextUsage } from '../../core/state/instance/instance.types';
import type { InstanceProvider, InstanceStatus } from '../../core/state/instance/instance.types';
import type { InstanceRuntimeSummary } from '../../../../shared/types/local-model-runtime.types';
import type { ReasoningEffort } from '../../../../shared/types/provider.types';
import { getModelSwitchUnavailableReason } from '../../../../shared/types/instance-status-policy';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import { DEFAULT_INSTANCE_PROVIDERS } from '../models/provider-menu.constants';

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
      @if (localRuntimeLabel()) {
        <span class="runtime-summary-chip" [title]="localRuntimeTitle()">
          {{ localRuntimeLabel() }}
        </span>
      } @else if (pickerSelection()) {
        <app-compact-model-picker
          mode="pending-create"
          [providers]="pickerProviders"
          [selection]="pickerSelection()!"
          [disabledReason]="modelSwitchDisabledReason()"
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

    .runtime-summary-chip {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      max-width: min(100%, 360px);
      padding: 0 10px;
      border: 1px solid rgba(20, 184, 166, 0.24);
      border-radius: 999px;
      background: rgba(20, 184, 166, 0.1);
      color: #9ee7dc;
      font: 10px var(--font-mono, monospace);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `],
})
export class ComposerToolbarComponent {
  private readonly ipc = inject(InstanceIpcService);
  /** Tracks which instance the picker was last fully seeded for. */
  private lastSeededInstanceId: string | null = null;

  constructor() {
    // Re-seed the picker from the bound instance's provider + model whenever the
    // instance changes. The live composer is a single reused node whose
    // [instanceId]/[provider]/[currentModel] inputs swap when you switch
    // sessions, so seeding once (the old ngOnInit) leaked the previous
    // instance's selection into the next — e.g. a Cursor pick showing up as
    // "Cursor · Auto" on a Claude session.
    //
    // On instance switch we always reset. Within a single instance we also
    // hydrate when `currentModel` arrives from Phase-2 spawn (it is absent on
    // the first IPC payload) but only while the picker still shows a placeholder
    // (null / `auto`). That fixes draft→live regressions like "Composer 2.5"
    // flipping to Auto without clobbering an in-flight user pick.
    effect(() => {
      const instanceId = this.instanceId();
      const provider = this.provider();
      const currentModel = this.currentModel();
      const currentReasoning = this.currentReasoningEffort() ?? null;
      const derived = deriveComposerPickerSelection(
        provider,
        currentModel,
        currentReasoning,
        this.runtimeSummary(),
      );
      const instanceChanged = instanceId !== this.lastSeededInstanceId;

      if (instanceChanged) {
        this.lastSeededInstanceId = instanceId;
        this.pendingSelection.set(derived);
        return;
      }

      const pending = untracked(() => this.pendingSelection());
      if (shouldHydrateComposerPickerSelection(pending, derived)) {
        this.pendingSelection.set(derived);
        return;
      }

      // Reconcile the reasoning effort from backend truth even when the model is
      // unchanged. The picker (pending-create mode) has no other source for the
      // instance's actual effort, so without this it would only ever display the
      // provider default (e.g. Claude's "High"), masking a real Max/Extra/etc.
      // and snapping a just-applied pick back to the default. Only writes when
      // the value genuinely diverges to avoid clobbering an in-flight pick whose
      // backend confirmation has not arrived yet (that confirmation re-runs this
      // effect with a matching value, making it a no-op).
      if (pending && pending.reasoning !== derived.reasoning) {
        this.pendingSelection.set({ ...pending, reasoning: derived.reasoning });
      }
    });
  }

  /** Instance ID — used to call changeModel IPC. */
  instanceId = input.required<string>();

  /** Context usage from the running instance. When absent, ring shows 0%. */
  contextUsage = input<ContextUsage | undefined>(undefined);

  /** Current provider for the instance (drives picker initial state). */
  provider = input<InstanceProvider>('claude');

  /** Current model for the instance (drives picker initial state). */
  currentModel = input<string | undefined>(undefined);

  /**
   * Current reasoning effort for the instance. The picker is the sole UI for
   * effort on a live instance, so it must reflect the real backend value rather
   * than always re-deriving to the provider default. `null`/`undefined` mean
   * "provider default" (the picker then badges e.g. Claude's High).
   */
  currentReasoningEffort = input<ReasoningEffort | null | undefined>(undefined);

  /** Runtime display metadata from the backend. Local-model sessions use this
   * label instead of pretending the backing CLI provider/model is the runtime. */
  runtimeSummary = input<InstanceRuntimeSummary | undefined>(undefined);

  /** Live instance status. Drives gating of the picker — the backend only
   * accepts model/reasoning switches while waiting for user input, so the
   * picker is disabled (with an explanatory tooltip) otherwise to avoid a
   * silently-rejected change. */
  instanceStatus = input<InstanceStatus | undefined>(undefined);

  /**
   * Reason the picker is disabled, or `undefined` when a switch is allowed.
   * Mirrors the backend's `changeModel` precondition so the UI matches it.
   */
  readonly modelSwitchDisabledReason = computed(() =>
    getModelSwitchUnavailableReason(this.instanceStatus()),
  );

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
  readonly localRuntimeLabel = computed(() => formatComposerRuntimeLabel(this.runtimeSummary()));
  readonly localRuntimeTitle = computed(() => {
    const summary = this.runtimeSummary();
    if (summary?.kind !== 'local-model') {
      return '';
    }
    return summary.modelId ? `Model: ${summary.modelId}` : summary.label;
  });

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

/**
 * Map a live instance's provider + model to the picker's initial selection.
 * Pure so the per-instance seed mapping is unit-testable without the Angular
 * compiler. `ollama` collapses to `claude` because the picker has no Ollama
 * tab; a missing model becomes `null` (the picker then shows the provider
 * default).
 */
export function deriveComposerPickerSelection(
  provider: InstanceProvider,
  currentModel: string | undefined,
  reasoning: ReasoningEffort | null = null,
  runtimeSummary?: InstanceRuntimeSummary,
): PendingSelection {
  if (runtimeSummary?.kind === 'local-model') {
    return {
      provider: 'local-model',
      model: runtimeSummary.modelId ?? currentModel ?? null,
      reasoning: null,
    };
  }

  const pickerProvider: PickerProvider = (provider === 'ollama' ? 'claude' : provider) as PickerProvider;
  return { provider: pickerProvider, model: currentModel ?? null, reasoning: reasoning ?? null };
}

export function formatComposerRuntimeLabel(
  runtimeSummary: InstanceRuntimeSummary | undefined,
): string | null {
  if (runtimeSummary?.kind !== 'local-model') {
    return null;
  }
  return `Local Models - ${runtimeSummary.label}`;
}

/**
 * Whether the live toolbar should adopt a newly-arrived instance model without
 * overwriting an explicit in-flight user pick. Placeholder states (null model
 * or the Cursor `auto` sentinel) are hydrated; concrete divergent picks are not.
 */
export function shouldHydrateComposerPickerSelection(
  pending: PendingSelection | null,
  derived: PendingSelection,
): boolean {
  const derivedModel = derived.model?.trim();
  if (!derivedModel || derivedModel.toLowerCase() === 'auto') {
    return false;
  }

  if (!pending || pending.provider !== derived.provider) {
    return true;
  }

  const pendingModel = pending.model?.trim().toLowerCase() ?? null;
  if (pendingModel === null || pendingModel === 'auto') {
    return pendingModel !== derivedModel.toLowerCase();
  }

  return false;
}
