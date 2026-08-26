import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import type { AuxiliaryLlmSlot } from '../../../../shared/types/auxiliary-llm.types';
import type {
  LocalAiFallbackRequest,
  LocalAiFallbackResolution,
} from '../../../../shared/types/local-ai-guard.types';
import {
  LOCAL_AI_RESOLUTION_ERROR,
  LOCAL_AI_STATUS_ERROR,
  LocalAiGuardStore,
} from '../../core/state/local-ai-guard.store';

const SLOT_LABELS: Record<AuxiliaryLlmSlot, string> = {
  compression: 'Compression',
  memoryDistillation: 'Memory distillation',
  webExtract: 'Web extraction',
  titleGeneration: 'Title generation',
  routingClassification: 'Routing classification',
  approvalScoring: 'Approval scoring',
  approvalAdjudication: 'Approval adjudication',
  loopScoring: 'Loop scoring',
  retrievalHypothesis: 'Retrieval hypothesis',
  branchScoring: 'Branch scoring',
  subQueryExecution: 'Sub-query execution',
  verifyOutputSummary: 'Output verification',
};

@Component({
  selector: 'app-local-ai-fallback-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="visually-hidden"
      aria-live="polite"
      aria-atomic="true"
      data-testid="local-ai-fallback-live"
    >{{ announcement() }}</span>

    @if (oldestPending(); as request) {
      <section
        class="local-ai-fallback-banner"
        [attr.data-request-id]="request.id"
        aria-labelledby="local-ai-fallback-title"
      >
        <div class="fallback-copy">
          <span class="fallback-mark" aria-hidden="true">↑</span>
          <div>
            <strong id="local-ai-fallback-title">Paid fallback needs a decision</strong>
            <span class="fallback-detail">
              {{ slotLabel(request.slot) }}
              <span aria-hidden="true">·</span>
              {{ tokenEstimate(request) }}
              <span aria-hidden="true">·</span>
              {{ costEstimate(request) }}
            </span>
            @if (store.error()) {
              <span class="fallback-error">{{ safeError() }}</span>
            }
          </div>
        </div>

        <div class="fallback-actions" aria-label="Paid fallback decisions">
          <button
            type="button"
            class="fallback-action primary"
            data-resolution="allow-once"
            [disabled]="isResolving()"
            (click)="resolve(request, 'allow-once')"
          >Allow once</button>
          <button
            type="button"
            class="fallback-action"
            data-resolution="allow-incident"
            [disabled]="isResolving()"
            (click)="resolve(request, 'allow-incident')"
          >Allow for incident</button>
          <button
            type="button"
            class="fallback-action"
            data-resolution="defer"
            [disabled]="isResolving()"
            (click)="resolve(request, 'defer')"
          >Keep local</button>
          <button
            type="button"
            class="fallback-action danger"
            data-resolution="block"
            [disabled]="isResolving()"
            (click)="resolve(request, 'block')"
          >Block</button>
          @if (isResolving()) {
            <span class="saving-label">Saving decision…</span>
          }
        </div>
      </section>
    }

  `,
  styles: [`
    :host {
      display: contents;
    }

    .local-ai-fallback-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-height: 48px;
      padding: 0.65rem 1rem;
      border-block: 1px solid var(--warning-border);
      background: color-mix(in srgb, var(--warning-bg) 82%, var(--bg-elevated));
      color: var(--text-primary);
      z-index: 1003;
    }

    .fallback-copy {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 0.7rem;
    }

    .fallback-copy > div {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.15rem 0.65rem;
      font-size: 0.82rem;
    }

    .fallback-mark {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      flex: 0 0 auto;
      border: 1px solid var(--pill-warn-border);
      border-radius: var(--radius-full);
      background: var(--pill-warn-bg);
      color: var(--pill-warn-fg);
      font-size: 0.9rem;
      font-weight: 800;
    }

    .fallback-detail {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      color: var(--text-secondary);
    }

    .fallback-error {
      color: var(--error-color);
    }

    .fallback-actions {
      display: flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 0.45rem;
    }

    .fallback-action {
      height: 29px;
      padding: 0 0.7rem;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--glass-medium);
      color: var(--text-primary);
      cursor: pointer;
      font: inherit;
      font-size: 0.76rem;
      font-weight: 650;
    }

    .fallback-action.primary {
      border-color: var(--pill-ok-border);
      background: var(--pill-ok-bg);
      color: var(--pill-ok-fg);
    }

    .fallback-action.danger {
      border-color: var(--pill-error-border);
      color: var(--pill-error-fg);
    }

    .fallback-action:hover:not(:disabled) {
      background: var(--glass-strong);
    }

    .fallback-action:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
    }

    .fallback-action:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .saving-label {
      color: var(--text-muted);
      font-size: var(--text-xs);
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    @media (max-width: 900px) {
      .local-ai-fallback-banner,
      .fallback-actions {
        flex-wrap: wrap;
      }
    }
  `],
})
export class LocalAiFallbackBannerComponent {
  protected readonly store = inject(LocalAiGuardStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly _announcement = signal('');
  private lastAnnouncementFingerprint = '';
  private announcementSequence = 0;
  private lastAnnouncedRequestKey = '';
  private hadPendingRequest = false;

  protected readonly announcement = this._announcement.asReadonly();
  protected readonly oldestPending = computed(() => {
    const requests = this.store.pendingFallbacks();
    return requests.length === 0
      ? null
      : [...requests].sort((left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
  });
  protected readonly isResolving = computed(() => this.store.resolvingFallbackId() !== null);

  constructor() {
    effect(() => {
      const request = this.oldestPending();
      const error = this.store.error();
      const requestKey = request ? `${request.id}:${request.createdAt}` : '';
      const fingerprint = request
        ? `${requestKey}:${error ?? ''}`
        : 'empty';
      if (fingerprint === this.lastAnnouncementFingerprint) return;

      this.lastAnnouncementFingerprint = fingerprint;
      if (request) {
        this.hadPendingRequest = true;
        if (error) {
          this._announcement.set(this.safeError());
        } else if (requestKey !== this.lastAnnouncedRequestKey) {
          this.announcementSequence += 1;
          this.lastAnnouncedRequestKey = requestKey;
          this._announcement.set(
            `New paid fallback request ${this.announcementSequence} for `
            + `${this.slotLabel(request.slot)}. ${this.tokenEstimate(request)}. `
            + `${this.costEstimate(request)}.`,
          );
        } else {
          this._announcement.set('');
        }
      } else if (this.hadPendingRequest) {
        this.hadPendingRequest = false;
        this.lastAnnouncedRequestKey = '';
        this._announcement.set('Paid fallback queue cleared.');
      }
    });
  }

  protected slotLabel(slot: AuxiliaryLlmSlot): string {
    return SLOT_LABELS[slot];
  }

  protected tokenEstimate(request: LocalAiFallbackRequest): string {
    return request.estimatedInputTokens > 0
      ? `${request.estimatedInputTokens.toLocaleString('en-GB')} input tokens`
      : 'Input tokens unknown';
  }

  protected costEstimate(request: LocalAiFallbackRequest): string {
    return request.estimatedCostUsd === undefined
      ? 'Cost unknown'
      : `$${request.estimatedCostUsd.toFixed(4)} estimated`;
  }

  protected safeError(): string {
    return this.store.error() === LOCAL_AI_STATUS_ERROR
      ? LOCAL_AI_STATUS_ERROR
      : LOCAL_AI_RESOLUTION_ERROR;
  }

  protected async resolve(
    request: LocalAiFallbackRequest,
    resolution: LocalAiFallbackResolution,
  ): Promise<void> {
    if (this.isResolving()) return;
    await this.store.resolveFallback(request.id, resolution);
    afterNextRender(
      () => this.restoreFocus(resolution),
      { injector: this.injector },
    );
  }

  private restoreFocus(resolution: LocalAiFallbackResolution): void {
    const selector = `[data-resolution="${resolution}"]`;
    const nextAction = this.host.nativeElement.querySelector<HTMLButtonElement>(selector);
    const statusChip = document.querySelector<HTMLButtonElement>(
      'app-local-ai-status-chip button',
    );
    (nextAction ?? statusChip)?.focus();
  }
}
