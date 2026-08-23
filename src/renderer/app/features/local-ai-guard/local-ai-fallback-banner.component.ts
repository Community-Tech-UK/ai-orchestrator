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
  LocalAiRoutingEvent,
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

    <!-- ============================================================
         LT-189: notify-and-allow fallbacks. These already resolved —
         there is no decision left to make — so this is a passive,
         dismissible discovery aid, not a blocking prompt. Renders
         independently of, and alongside, the require-confirmation
         banner above.
         ============================================================ -->
    @if (undismissedNotifications().length > 0) {
      <section
        class="local-ai-fallback-notifications"
        aria-live="polite"
        aria-labelledby="local-ai-fallback-notifications-title"
      >
        <h2 id="local-ai-fallback-notifications-title" class="visually-hidden">
          Paid fallback notifications
        </h2>
        @for (event of undismissedNotifications(); track event.id) {
          <div class="fallback-notification" [attr.data-event-id]="event.id">
            <span class="notification-mark" aria-hidden="true">↑</span>
            <div class="notification-copy">
              <strong>Paid fallback happened automatically</strong>
              <span class="notification-detail">
                {{ slotLabel(event.slot) }}
                <span aria-hidden="true">·</span>
                {{ notificationCostLabel(event) }}
              </span>
            </div>
            <button
              type="button"
              class="notification-dismiss"
              (click)="dismissNotification(event.id)"
            >Dismiss</button>
          </div>
        }
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

    .local-ai-fallback-notifications {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      padding: 0.5rem 1rem;
    }

    .fallback-notification {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.7rem;
      padding: 0.5rem 0.8rem;
      border: 1px solid var(--info-border);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--info-bg) 82%, var(--bg-elevated));
      color: var(--text-primary);
    }

    .notification-mark {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      flex: 0 0 auto;
      border: 1px solid var(--pill-info-border);
      border-radius: var(--radius-full);
      background: var(--pill-info-bg);
      color: var(--pill-info-fg);
      font-size: 0.85rem;
      font-weight: 800;
    }

    .notification-copy {
      display: flex;
      flex: 1 1 auto;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.15rem 0.65rem;
      min-width: 0;
      font-size: 0.8rem;
    }

    .notification-detail {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      color: var(--text-secondary);
    }

    .notification-dismiss {
      flex: 0 0 auto;
      height: 27px;
      padding: 0 0.6rem;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--glass-medium);
      color: var(--text-secondary);
      cursor: pointer;
      font: inherit;
      font-size: 0.74rem;
    }

    .notification-dismiss:hover {
      background: var(--glass-strong);
      color: var(--text-primary);
    }

    .notification-dismiss:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
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
  /** LT-189 — passive, dismissible `notify-and-allow` fallback events. */
  protected readonly undismissedNotifications = computed(() => this.store.fallbackNotifications());

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

  /** LT-189 — mirrors `costEstimate` but reads a raw routing event, which
   * (unlike a fallback request) can also carry a settled `knownCostUsd`. */
  protected notificationCostLabel(event: LocalAiRoutingEvent): string {
    if (event.knownCostUsd !== undefined) return `$${event.knownCostUsd.toFixed(4)} measured`;
    if (event.estimatedCostUsd !== undefined) return `$${event.estimatedCostUsd.toFixed(4)} estimated`;
    return 'Cost unknown';
  }

  protected dismissNotification(eventId: string): void {
    this.store.dismissFallbackNotification(eventId);
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
