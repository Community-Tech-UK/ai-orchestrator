import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, OnDestroy, OnInit, output, signal, viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import type { ReasoningEffort } from '../../../../shared/types/provider.types';
import { PROVIDER_MENU_LABELS } from '../models/provider-menu.constants';
import { PlanModeIpcService } from '../../core/services/ipc/plan-mode-ipc.service';
import { InstanceStateService } from '../../core/state/instance/instance-state.service';
import { ToastService } from '../../core/services/toast.service';
import { createFocusTrap, type FocusTrapHandle } from '../../shared/utils/focus-trap';

interface PlanHandoffPreview {
  planText: string;
  truncated: boolean;
  source: 'plan-mode' | 'assistant';
  /** `null`/absent when main has no real occupancy reading to report. */
  planningContextTokens?: number | null;
  planTokensEstimate: number;
  provider: string;
  model?: string;
  reasoningEffort?: ReasoningEffort | null;
  canStart: boolean;
  reason?: string;
}

@Component({
  selector: 'app-plan-handoff-dialog',
  standalone: true,
  imports: [DecimalPipe, CompactModelPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #dialog class="plan-handoff-overlay" role="dialog" aria-modal="true" aria-label="Build in a new session"
      (keydown.escape)="onEscape($event)">
      <div class="plan-handoff-dialog">
        <h2>Build in a new session</h2>
        <p>
          Harness opens a new session in this folder. It gets only the plan below
          (about {{ planTokens() | number }} tokens)@if (planningTokens() !== null) {, not the whole planning conversation
          (about {{ planningTokens() | number }} tokens)}, and starts by
          re-reading the files the plan names. This planning session stays open.
        </p>
        <p>Attachments from this planning session are not carried over.</p>
        @if (preview()?.truncated) {
          <p class="warning">The plan was cut to fit. Review and edit it before starting.</p>
        }
        @if (preview() && !preview()!.canStart) {
          <p class="warning">{{ preview()!.reason }}</p>
        }
        <label for="plan-handoff-text">Plan</label>
        <textarea id="plan-handoff-text" rows="14" [value]="planText()"
          (input)="onPlanInput($event)"></textarea>
        <div class="model-choice">
          <span>Model: {{ modelOverride() ?? 'Same as planning' }}</span>
          @if (selection(); as current) {
            <app-compact-model-picker mode="pending-create" [selection]="current"
              [providers]="[current.provider]" [showSelectionStatus]="false" [trapFocus]="true"
              [allowReasoningSelection]="false"
              (selectionChange)="onSelectionChange($event)" />
          }
          @if (modelOverride()) {
            <button type="button" (click)="usePlanningModel()">Same as planning</button>
          }
        </div>
        @if (error()) { <p class="warning" role="alert">{{ error() }}</p> }
        <div class="actions">
          <button type="button" (click)="dismiss()" [disabled]="starting()">Cancel</button>
          <button type="button" (click)="start()"
            [disabled]="starting() || !preview()?.canStart || !planText().trim()">
            {{ starting() ? 'Starting…' : 'Start new session' }}
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .plan-handoff-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; }
    .plan-handoff-dialog { width: min(720px, 92vw); max-height: 90vh; overflow: auto; padding: 1.25rem; border-radius: var(--radius-md); background: var(--bg-primary); color: var(--text-primary); box-shadow: 0 12px 40px rgba(0,0,0,.3); }
    h2 { margin: 0 0 .75rem; } p { font-size: .9rem; line-height: 1.5; }
    label { display: block; margin: .75rem 0 .25rem; }
    textarea { box-sizing: border-box; width: 100%; padding: .6rem; color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); }
    .model-choice { display: flex; align-items: center; gap: .75rem; margin: .75rem 0; }
    .warning { color: var(--warning-color); }
    .actions { display: flex; justify-content: flex-end; gap: .5rem; }
    button { padding: .45rem .9rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; }
    button:disabled { opacity: .6; cursor: default; }
  `],
})
export class PlanHandoffDialogComponent implements OnInit, OnDestroy {
  readonly sourceId = input.required<string>();
  readonly requestId = input<string | undefined>();
  readonly closed = output<void>();
  readonly started = output<string>();

  private readonly ipc = inject(PlanModeIpcService);
  private readonly instanceState = inject(InstanceStateService);
  private readonly toast = inject(ToastService);
  private readonly idempotencyKey = crypto.randomUUID();

  protected readonly preview = signal<PlanHandoffPreview | null>(null);
  protected readonly planText = signal('');
  protected readonly selection = signal<PendingSelection | null>(null);
  protected readonly modelOverride = computed(() => {
    const selected = this.selection();
    const preview = this.preview();
    return selected?.provider === preview?.provider && selected?.model !== preview?.model
      ? selected?.model ?? undefined : undefined;
  });
  protected readonly starting = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Real window occupancy from main, or `null` so the sentence leaves the figure out. */
  protected readonly planningTokens = computed(() => {
    const tokens = this.preview()?.planningContextTokens;
    return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null;
  });
  protected readonly planTokens = computed(() => Math.ceil(this.planText().length / 4));

  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private focusTrap: FocusTrapHandle | null = null;

  constructor() {
    effect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (!dialog || this.focusTrap) return;
      this.focusTrap = createFocusTrap(dialog);
      this.focusTrap.activate();
    });
  }

  ngOnDestroy(): void {
    this.closeFocusTrap();
  }

  protected onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.dismiss();
  }

  protected dismiss(): void {
    if (this.starting()) return;
    this.closeFocusTrap();
    this.closed.emit();
  }

  private closeFocusTrap(): void {
    this.focusTrap?.deactivate();
    this.focusTrap?.restore();
    this.focusTrap = null;
  }

  async ngOnInit(): Promise<void> {
    const response = await this.ipc.previewPlanHandoff(this.sourceId());
    if (!response.success || !response.data) {
      this.error.set(response.error?.message ?? 'Could not read the plan.');
      return;
    }
    const preview = response.data as PlanHandoffPreview;
    this.preview.set(preview);
    this.planText.set(preview.planText);
    this.usePlanningModel();
    if (!preview.canStart) this.error.set(preview.reason ?? 'There is no plan to carry over.');
  }

  onPlanInput(event: Event): void {
    this.planText.set((event.target as HTMLTextAreaElement).value);
  }

  usePlanningModel(): void {
    const preview = this.preview();
    if (preview && Object.hasOwn(PROVIDER_MENU_LABELS, preview.provider)) {
      this.selection.set({
        provider: preview.provider as PickerProvider, model: preview.model ?? null, reasoning: preview.reasoningEffort ?? null,
      });
    }
  }

  onSelectionChange(selection: PendingSelection): void {
    const preview = this.preview();
    if (selection.provider === preview?.provider) this.selection.set({ ...selection, reasoning: preview.reasoningEffort ?? null });
  }

  async start(): Promise<void> {
    if (this.starting() || !this.preview()?.canStart || !this.planText().trim()) return;
    this.starting.set(true);
    this.error.set(null);
    try {
      const response = await this.ipc.startPlanHandoff({
        instanceId: this.sourceId(), requestId: this.requestId(),
        planText: this.planText(), model: this.modelOverride(),
        idempotencyKey: this.idempotencyKey,
      });
      const data = response.data as { newInstanceId?: string } | undefined;
      if (!response.success || !data?.newInstanceId) {
        this.error.set(response.error?.message ?? 'Could not start the build session.');
        return;
      }
      // Restore before selection/output callbacks can focus the new session.
      this.closeFocusTrap();
      this.instanceState.setSelectedInstance(data.newInstanceId);
      this.toast.show('Building in a new session.', 'success');
      this.started.emit(data.newInstanceId);
      this.closed.emit();
    } catch {
      this.error.set('Could not start the build session.');
    } finally {
      this.starting.set(false);
    }
  }
}
