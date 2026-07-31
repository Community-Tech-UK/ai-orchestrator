/**
 * Manual Compaction Preview Dialog (WS-B7)
 *
 * Shows what manual compaction would actually do before it runs: affected
 * range, token estimate + its source, protected items, and whether the
 * provider self-manages compaction (in which case AIO has no boundary
 * control and says so). Confirming routes through the boundary-aware apply
 * path, which creates a pre-compaction checkpoint server-side.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { ToastService } from '../../core/services/toast.service';
import { createFocusTrap, type FocusTrapHandle } from '../../shared/utils/focus-trap';
import type { CompactionPreview } from '../../../../shared/types/compaction-preview.types';

/** Debounce for re-previewing after the user edits the "keep latest N exchanges" field. */
const PREVIEW_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-compaction-preview-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isOpen()) {
      <div
        #overlay
        class="cpd-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cpd-title"
        tabindex="-1"
        (click)="onCancel()"
        (keydown.escape)="onCancel()"
      >
        <div class="cpd-container" role="document" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
          <div class="cpd-header">
            <span id="cpd-title" class="cpd-title">Preview compaction</span>
            <button type="button" class="cpd-close" aria-label="Cancel" (click)="onCancel()">✕</button>
          </div>

          @if (loading()) {
            <p class="cpd-status">Loading preview…</p>
          } @else if (error()) {
            <p class="cpd-status cpd-error" role="alert">{{ error() }}</p>
          } @else if (preview(); as p) {
            @if (p.mode === 'adapter-self-managed') {
              <p class="cpd-note" role="note">{{ p.note }}</p>
            } @else if (p.mode === 'unavailable') {
              <p class="cpd-note cpd-error" role="alert">{{ p.note }}</p>
            } @else {
              <dl class="cpd-facts">
                <dt>Will be summarized</dt>
                <dd>
                  @if (p.affectedRange.messageCount > 0) {
                    {{ p.affectedRange.messageCount }} message(s)
                  } @else {
                    Nothing — the kept window already covers the whole transcript.
                  }
                </dd>
                <dt>Kept verbatim</dt>
                <dd>{{ p.keptVerbatimCount }} message(s) of {{ p.totalMessageCount }} total</dd>
                <dt>Estimated tokens summarized</dt>
                <dd>~{{ p.tokenEstimate.value }} ({{ p.tokenEstimate.source }})</dd>
                @if (p.protectedItems.mostRecentUserTurnProtected) {
                  <dt>Protected</dt>
                  <dd>Your most recent message stays verbatim, even if it falls in the summarized range.</dd>
                }
                @if (p.protectedItems.authenticatedEvidencePreserved) {
                  <dt>Evidence</dt>
                  <dd>Authenticated ledger evidence is preserved in the summary, not lost.</dd>
                }
              </dl>

              <div class="cpd-field">
                <label for="cpd-keep-latest">Keep latest N exchanges verbatim</label>
                <input
                  id="cpd-keep-latest"
                  type="number"
                  min="0"
                  [max]="maxExchanges()"
                  [value]="keepLatestExchanges()"
                  [disabled]="applying()"
                  aria-describedby="cpd-keep-latest-hint"
                  (input)="onKeepLatestExchangesInput($any($event.target).value)"
                />
                <p id="cpd-keep-latest-hint" class="cpd-hint">
                  Out of {{ p.totalExchangeCount }} exchange(s) currently in this session.
                </p>
              </div>
            }
          }

          <div class="cpd-footer">
            <button type="button" class="cpd-btn cpd-secondary" [disabled]="applying()" (click)="onCancel()">Cancel</button>
            <button
              type="button"
              class="cpd-btn cpd-primary"
              [disabled]="!canConfirm()"
              (click)="onConfirm()"
            >{{ applying() ? 'Compacting…' : 'Confirm' }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .cpd-overlay {
      position: fixed;
      inset: 0;
      z-index: 1100;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      -webkit-app-region: no-drag;
    }
    .cpd-container {
      width: 460px;
      max-width: 90vw;
      max-height: 85vh;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
      background: var(--surface-bg, var(--bg-secondary, #1e1e2e));
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
      border-radius: 10px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    }
    .cpd-header { display: flex; align-items: center; gap: 8px; }
    .cpd-title { flex: 1; font-size: 14px; font-weight: 600; color: var(--text-primary, #cdd6f4); }
    .cpd-close {
      width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
      border: none; background: transparent; color: var(--text-muted, #6c7086);
      font-size: 13px; cursor: pointer; border-radius: 4px;
    }
    .cpd-close:hover { background: var(--hover-bg, rgba(255, 255, 255, 0.08)); color: var(--text-primary, #cdd6f4); }
    .cpd-status { margin: 0; font-size: 13px; color: var(--text-secondary, #a6adc8); }
    .cpd-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary, #a6adc8); }
    .cpd-error { color: var(--error-color, #f38ba8); }
    .cpd-facts { margin: 0; font-size: 12px; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
    .cpd-facts dt { font-weight: 600; color: var(--text-secondary, #a6adc8); }
    .cpd-facts dd { margin: 0; color: var(--text-primary, #cdd6f4); }
    .cpd-field { display: flex; flex-direction: column; gap: 4px; }
    .cpd-field label { font-size: 12px; font-weight: 600; color: var(--text-secondary, #a6adc8); }
    .cpd-field input {
      width: 100px; padding: 6px 8px; background: var(--bg-tertiary, rgba(0, 0, 0, 0.25));
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12)); border-radius: 6px;
      color: var(--text-primary, #cdd6f4); font: inherit; font-size: 13px;
    }
    .cpd-hint { margin: 0; font-size: 11px; color: var(--text-muted, #6c7086); }
    .cpd-footer { display: flex; justify-content: flex-end; gap: 8px; }
    .cpd-btn {
      padding: 6px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;
      cursor: pointer; border: 1px solid transparent; transition: all 0.15s;
    }
    .cpd-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .cpd-secondary {
      background: transparent; border-color: var(--border-color, rgba(255, 255, 255, 0.12));
      color: var(--text-secondary, #a6adc8);
    }
    .cpd-secondary:hover:not(:disabled) { background: var(--hover-bg, rgba(255, 255, 255, 0.08)); color: var(--text-primary, #cdd6f4); }
    .cpd-primary { background: var(--accent-color, #89b4fa); color: #1e1e2e; }
    .cpd-primary:hover:not(:disabled) { filter: brightness(1.1); }
  `],
})
export class CompactionPreviewDialogComponent implements OnDestroy {
  private readonly ipc = inject(InstanceIpcService);
  private readonly toast = inject(ToastService);

  instanceId = input<string | null>(null);
  isOpen = input(false);

  closed = output<void>();

  protected readonly preview = signal<CompactionPreview | null>(null);
  protected readonly loading = signal(false);
  protected readonly applying = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly keepLatestExchanges = signal(0);
  protected readonly maxExchanges = computed(() => this.preview()?.totalExchangeCount ?? 0);
  protected readonly canConfirm = computed(() => !this.loading() && !this.applying() && !this.error());

  private readonly overlay = viewChild<ElementRef<HTMLElement>>('overlay');
  private focusTrap: FocusTrapHandle | null = null;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private requestSeq = 0;

  constructor() {
    effect(() => {
      const open = this.isOpen();
      const id = this.instanceId();
      if (!open || !id) {
        this.closeFocusTrap();
        return;
      }
      untracked(() => {
        this.resetState();
        void this.loadPreview(undefined);
      });
      queueMicrotask(() => {
        if (this.destroyed || !this.isOpen()) return;
        this.openFocusTrap();
      });
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.closeFocusTrap();
  }

  protected onKeepLatestExchangesInput(raw: string): void {
    const parsed = Number(raw);
    const clamped = Number.isFinite(parsed)
      ? Math.max(0, Math.min(Math.floor(parsed), this.maxExchanges()))
      : 0;
    this.keepLatestExchanges.set(clamped);
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      void this.loadPreview(clamped);
    }, PREVIEW_DEBOUNCE_MS);
  }

  protected async onConfirm(): Promise<void> {
    const id = this.instanceId();
    if (!id || !this.canConfirm()) return;
    this.applying.set(true);
    this.error.set(null);
    const response = await this.ipc.applyCompactionWithOptions(id, {
      keepLatestExchanges: this.keepLatestExchanges(),
    });
    this.applying.set(false);
    if (!response.success) {
      const message = response.error?.message ?? 'Compaction failed.';
      this.error.set(message);
      this.toast.show(message, 'error');
      return;
    }
    this.toast.show('Compaction complete.', 'success');
    this.closed.emit();
  }

  protected onCancel(): void {
    this.closed.emit();
  }

  private async loadPreview(keepLatestExchanges: number | undefined): Promise<void> {
    const id = this.instanceId();
    if (!id) return;
    const seq = ++this.requestSeq;
    this.loading.set(keepLatestExchanges === undefined);
    this.error.set(null);
    const response = await this.ipc.previewCompaction(id, { keepLatestExchanges });
    // A newer request (from a fast follow-up edit) already superseded this one.
    if (seq !== this.requestSeq) return;
    this.loading.set(false);
    if (!response.success || !response.data) {
      this.error.set(response.error?.message ?? 'Failed to load compaction preview.');
      return;
    }
    this.preview.set(response.data);
    if (keepLatestExchanges === undefined) {
      this.keepLatestExchanges.set(response.data.keepLatestExchanges);
    }
  }

  private resetState(): void {
    this.preview.set(null);
    this.loading.set(false);
    this.applying.set(false);
    this.error.set(null);
    this.keepLatestExchanges.set(0);
    this.requestSeq++;
  }

  private openFocusTrap(): void {
    if (this.focusTrap) return;
    const overlay = this.overlay()?.nativeElement;
    if (!overlay) return;
    this.focusTrap = createFocusTrap(overlay);
    this.focusTrap.activate();
  }

  private closeFocusTrap(): void {
    this.focusTrap?.deactivate();
    this.focusTrap?.restore();
    this.focusTrap = null;
  }
}
