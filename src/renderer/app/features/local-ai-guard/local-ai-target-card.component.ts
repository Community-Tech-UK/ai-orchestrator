import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { AuxiliaryLlmSlot } from '../../../../shared/types/auxiliary-llm.types';
import type {
  LocalAiDiscoveredEndpoint,
  LocalAiIncident,
  LocalAiProbeEvidenceValue,
  LocalAiProbeResult,
  LocalAiTargetLifecycleOptions,
  LocalAiTarget,
  LocalAiTargetStatus,
  LocalAiPublicRecoveryAttempt,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LOCAL_AI_GUARD_CLOCK } from './local-ai-guard-clock';
import { LocalAiModalCoordinator } from './local-ai-modal-coordinator';

interface EvidenceStage {
  id: 'worker' | 'endpoint' | 'model' | 'canary';
  label: string;
  result?: LocalAiProbeResult;
}

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
  selector: 'app-local-ai-target-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article
      class="target-card"
      [attr.data-target-id]="status().targetId"
      [attr.data-state]="status().state"
      [attr.aria-labelledby]="'target-title-' + status().targetId"
    >
      <span class="visually-hidden" aria-live="polite" aria-atomic="true">{{ announcement() }}</span>

      <header class="target-header">
        <div>
          <p class="target-location">{{ locationLabel() }}</p>
          <h2 [id]="'target-title-' + status().targetId">{{ targetLabel() }}</h2>
          <p class="target-meta">
            {{ advertisementLabel() }}
            · Evidence {{ ageLabel(status().checkedAt) }}
            · {{ status().consecutiveFailures }} consecutive failure{{ status().consecutiveFailures === 1 ? '' : 's' }}
          </p>
        </div>
        <span class="state-pill">{{ stateLabel(status().state) }}</span>
      </header>

      <ol class="evidence-rail" aria-label="Worker to canary health evidence">
        @for (stage of stages(); track stage.id) {
          <li [attr.data-layer]="stage.id" [attr.data-state]="stageState(stage.result)">
            <span class="rail-node" aria-hidden="true"></span>
            <strong>{{ stage.label }}</strong>
            <span>{{ evidenceSummary(stage.result) }}</span>
            <time [attr.datetime]="isoTime(stage.result?.checkedAt)">
              {{ stage.result ? ageLabel(stage.result.checkedAt) : 'No evidence' }}
            </time>
          </li>
        }
      </ol>

      <div class="evidence-summary">
        <div>
          <span>Last success</span>
          <strong>{{ ageOrNone(lastSuccess()) }}</strong>
        </div>
        <div>
          <span>Last failure</span>
          <strong>{{ ageOrNone(lastFailure()) }}</strong>
        </div>
        <div>
          <span>Routing roles</span>
          <strong>{{ roleLabels() || 'None currently eligible' }}</strong>
        </div>
        <div>
          <span>Fallback impact</span>
          <strong>
            {{ fallbackCount() }} paid fallback{{ fallbackCount() === 1 ? '' : 's' }}
            · {{ fallbackCostLabel() }}
          </strong>
        </div>
      </div>

      @if (missingModels().length > 0) {
        <section class="drift" aria-label="Configuration drift">
          <strong>Configuration drift</strong>
          <span>Expected but not advertised: {{ missingModels().join(', ') }}</span>
          @if (advertisedModels().length > 0) {
            <span>Currently advertised: {{ advertisedModels().join(', ') }}</span>
          }
        </section>
      }

      <p class="recovery-note">
        Recovery attempts:
        {{ recoveryLabel() }}
      </p>

      @if (store.operationError()) {
        <p class="operation-error" role="alert">
          The Local AI Guard operation could not be completed. Try again.
        </p>
      }

      <footer class="target-actions" aria-label="Target actions">
        <button type="button" [disabled]="isBusy()" (click)="runCheck()">Run check</button>
        <button type="button" [disabled]="isBusy()" (click)="editRequested.emit()">Edit</button>
        @if (status().state === 'paused' || status().lifecycle === 'paused') {
          <button type="button" [disabled]="isBusy()" (click)="resume()">Resume</button>
        } @else {
          <button type="button" [disabled]="isBusy()" (click)="pause()">Pause</button>
          <button type="button" [disabled]="isBusy()" (click)="pauseForOneHour()">Pause for 1 hour</button>
        }
        <button
          #retireTrigger
          type="button"
          class="danger"
          [disabled]="isBusy()"
          (click)="requestRetirement()"
        >Retire</button>
      </footer>

      @if (confirmingRetirement()) {
        <div class="dialog-backdrop">
          <section
            class="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            [attr.aria-labelledby]="'retire-target-title-' + status().targetId"
            [attr.aria-describedby]="'retire-target-description-' + status().targetId"
          >
            <h3 [id]="'retire-target-title-' + status().targetId">Retire {{ targetLabel() }}?</h3>
            <p [id]="'retire-target-description-' + status().targetId">
              Monitoring and routing stop immediately. Historical incidents remain available.
            </p>
            @if (retirementError()) {
              <p class="operation-error" role="alert">This target could not be retired. Try again.</p>
            }
            <div>
              <button type="button" (click)="cancelRetirement()">Cancel</button>
              <button type="button" class="danger" [disabled]="isBusy()" (click)="retire()">
                Confirm retirement
              </button>
            </div>
          </section>
        </div>
      }
    </article>
  `,
  styles: [`
    :host { display: block; }
    .target-card {
      position: relative;
      padding: var(--spacing-lg);
      border: 1px solid var(--card-border);
      border-radius: var(--card-radius);
      background: var(--card-bg);
    }
    .target-card[data-state='degraded'] { border-color: var(--warning-border); }
    .target-card[data-state='unavailable'] { border-color: var(--error-border); }
    .target-card[data-state='healthy'] { border-color: var(--success-border); }
    .target-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--spacing-md);
    }
    .target-location,
    .target-meta {
      margin: 0;
      color: var(--text-secondary);
      font-size: var(--text-xs);
    }
    .target-location {
      font-family: var(--font-mono);
      font-weight: 700;
    }
    h2 { margin: 0.2rem 0; font-size: var(--text-lg); }
    .state-pill {
      padding: 0.25rem 0.6rem;
      border: 1px solid var(--pill-neutral-border);
      border-radius: var(--radius-full);
      background: var(--pill-neutral-bg);
      color: var(--pill-neutral-fg);
      font-size: var(--text-xs);
      font-weight: 750;
    }
    [data-state='healthy'] > .target-header .state-pill,
    .evidence-rail li[data-state='ok'] .rail-node {
      border-color: var(--pill-ok-border);
      background: var(--pill-ok-bg);
      color: var(--pill-ok-fg);
    }
    [data-state='degraded'] > .target-header .state-pill {
      border-color: var(--pill-warn-border);
      background: var(--pill-warn-bg);
      color: var(--pill-warn-fg);
    }
    [data-state='unavailable'] > .target-header .state-pill,
    .evidence-rail li[data-state='failed'] .rail-node {
      border-color: var(--pill-error-border);
      background: var(--pill-error-bg);
      color: var(--pill-error-fg);
    }
    .evidence-rail {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      margin: var(--spacing-lg) 0;
      padding: 0;
      list-style: none;
    }
    .evidence-rail li {
      position: relative;
      display: grid;
      justify-items: center;
      gap: 0.15rem;
      text-align: center;
      color: var(--text-secondary);
      font-size: var(--text-xs);
    }
    .evidence-rail li::before {
      content: '';
      position: absolute;
      top: 9px;
      left: 0;
      right: 0;
      height: 1px;
      background: var(--border-color);
    }
    .evidence-rail li:first-child::before { left: 50%; }
    .evidence-rail li:last-child::before { right: 50%; }
    .rail-node {
      position: relative;
      z-index: 1;
      width: 18px;
      height: 18px;
      border: 1px solid var(--pill-neutral-border);
      border-radius: var(--radius-full);
      background: var(--pill-neutral-bg);
    }
    .evidence-rail strong { color: var(--text-primary); }
    .evidence-rail time { color: var(--text-muted); }
    .evidence-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--spacing-sm);
    }
    .evidence-summary > div {
      display: grid;
      gap: 0.2rem;
      min-width: 0;
      padding: var(--spacing-sm);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
    }
    .evidence-summary span,
    .recovery-note { color: var(--text-secondary); font-size: var(--text-xs); }
    .evidence-summary strong { overflow-wrap: anywhere; font-size: var(--text-sm); }
    .drift {
      display: grid;
      gap: 0.2rem;
      margin-top: var(--spacing-md);
      padding: var(--spacing-sm);
      border-left: 3px solid var(--warning-border);
      background: var(--warning-bg);
      color: var(--text-secondary);
      font-size: var(--text-sm);
    }
    .drift strong { color: var(--text-primary); }
    .recovery-note { margin: var(--spacing-md) 0 0; }
    .target-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-md);
      padding-top: var(--spacing-md);
      border-top: 1px solid var(--border-color);
    }
    button {
      min-height: 32px;
      padding: 0.35rem 0.7rem;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--glass-medium);
      color: var(--text-primary);
      font: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--glass-strong); }
    button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    button:disabled { cursor: default; opacity: 0.5; }
    button.danger { border-color: var(--pill-error-border); color: var(--pill-error-fg); }
    .operation-error { color: var(--error-color); font-size: var(--text-sm); }
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1200;
      display: grid;
      place-items: center;
      padding: var(--spacing-lg);
      background: var(--modal-backdrop);
    }
    .confirm-dialog {
      width: min(420px, 100%);
      padding: var(--spacing-lg);
      border: 1px solid var(--error-border);
      border-radius: var(--card-radius);
      background: var(--bg-elevated);
      box-shadow: var(--shadow-lg);
    }
    .confirm-dialog h3 { margin: 0 0 var(--spacing-sm); }
    .confirm-dialog p { color: var(--text-secondary); }
    .confirm-dialog div { display: flex; justify-content: flex-end; gap: var(--spacing-sm); }
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
    @media (max-width: 760px) {
      .evidence-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .evidence-rail { grid-template-columns: 1fr; gap: var(--spacing-sm); }
      .evidence-rail li {
        grid-template-columns: 22px 70px 1fr auto;
        justify-items: start;
        text-align: left;
      }
      .evidence-rail li::before {
        top: 0; bottom: 0; left: 9px; right: auto; width: 1px; height: auto;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; animation: none !important; }
    }
  `],
})
export class LocalAiTargetCardComponent {
  protected readonly store = inject(LocalAiGuardStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly clock = inject(LOCAL_AI_GUARD_CLOCK);
  private readonly modal = inject(LocalAiModalCoordinator);

  readonly status = input.required<LocalAiTargetStatus>();
  readonly targetConfig = input<LocalAiTarget | null>(null);
  readonly discovery = input<LocalAiDiscoveredEndpoint | null>(null);
  readonly incidents = input<LocalAiIncident[]>([]);
  readonly now = input(Date.now());
  readonly editRequested = output<void>();
  readonly retired = output<void>();

  protected readonly confirmingRetirement = computed(() =>
    this.modal.activeKey() === this.retirementModalKey());
  protected readonly retirementError = signal(false);
  protected readonly announcement = signal('');
  protected readonly stages = computed<EvidenceStage[]>(() => [
    { id: 'worker', label: 'Worker', result: this.status().layers.worker },
    { id: 'endpoint', label: 'Endpoint', result: this.status().layers.endpoint },
    { id: 'model', label: 'Model', result: this.status().layers.model },
    { id: 'canary', label: 'Canary', result: this.status().layers.inference },
  ]);
  protected readonly lastSuccess = computed(() => this.newestLayerTimestamp(true));
  protected readonly lastFailure = computed(() => this.newestLayerTimestamp(false));
  protected readonly fallbackCount = computed(() =>
    this.incidents().reduce((total, incident) => total + incident.fallbackCount, 0));
  protected readonly missingModels = computed(() =>
    this.stringArrayEvidence(this.status().layers.model, 'missingModels'));
  protected readonly advertisedModels = computed(() =>
    this.stringArrayEvidence(this.status().layers.model, 'advertisedModels'));
  protected readonly roleLabels = computed(() =>
    this.status().routableRoles.map((role) => SLOT_LABELS[role]).join(', '));
  protected readonly isBusy = computed(() => this.store.operationKey() !== null);

  @HostListener('document:keydown', ['$event'])
  protected onDialogKeydown(event: KeyboardEvent): void {
    if (!this.confirmingRetirement()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelRetirement();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = Array.from(
      this.host.nativeElement.querySelectorAll<HTMLButtonElement>(
        '.confirm-dialog button:not(:disabled)',
      ),
    );
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) return;
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  }

  protected targetLabel(): string {
    return this.targetConfig()?.label ?? `Target ${this.status().targetId.slice(0, 8)}`;
  }

  protected locationLabel(): string {
    const location = this.targetConfig()?.location;
    if (!location) return 'Endpoint location unavailable';
    return location.type === 'worker'
      ? 'Worker endpoint'
      : 'Coordinator endpoint';
  }

  protected advertisementLabel(): string {
    return this.discovery() ? 'Currently advertised' : 'Not currently advertised';
  }

  protected stateLabel(state: LocalAiTargetStatus['state']): string {
    return state.charAt(0).toUpperCase() + state.slice(1);
  }

  protected stageState(result: LocalAiProbeResult | undefined): string {
    if (!result) return 'unchecked';
    return result.ok ? 'ok' : 'failed';
  }

  protected evidenceSummary(result: LocalAiProbeResult | undefined): string {
    if (!result) return 'Not checked';
    if (result.ok) return `${result.durationMs} ms`;
    return result.failureCode
      ? result.failureCode.split('-').map(capitalize).join(' ')
      : 'Needs attention';
  }

  protected ageLabel(timestamp: number): string {
    const seconds = Math.max(0, Math.floor((this.now() - timestamp) / 1_000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }

  protected ageOrNone(timestamp: number | null): string {
    return timestamp === null ? 'None recorded' : this.ageLabel(timestamp);
  }

  protected isoTime(timestamp: number | undefined): string | null {
    return timestamp === undefined ? null : new Date(timestamp).toISOString();
  }

  protected fallbackCostLabel(): string {
    const known = this.incidents().reduce((total, incident) => total + incident.knownCostUsd, 0);
    const estimated = this.incidents()
      .reduce((total, incident) => total + incident.estimatedCostUsd, 0);
    // LT-193: an unpriced dispatch (no known or estimated cost) must not
    // read as "no recorded cost" — that claims zero, not unknown.
    const unpriced = this.incidents()
      .reduce((total, incident) => total + incident.unpricedDispatchCount, 0);
    const suffix = unpriced > 0 ? ` + ${unpriced} unpriced` : '';
    if (known > 0) return `$${known.toFixed(2)} measured${suffix}`;
    if (estimated > 0) return `$${estimated.toFixed(2)} estimated${suffix}`;
    if (unpriced > 0) return `cost unknown (${unpriced} unpriced)`;
    return 'no recorded cost';
  }

  protected recoveryLabel(): string {
    const durable = this.latestRecoveryAttempt();
    if (durable) {
      return `${this.actionLabel(durable.action)} ${durable.outcome.replace('-', ' ')}`;
    }
    const result = this.store.repairFor(this.status().targetId);
    if (!result) return 'none recorded';
    const action = this.actionLabel(result.action);
    switch (result.outcome) {
      case 'guided':
        return result.supported
          ? `${action} guidance shown`
          : `${action} unsupported`;
      case 'unsupported':
        return `${action} unsupported`;
      case 'not-attempted':
        return `${action} not attempted`;
      case 'execution-failed':
        return `${action} failed`;
      case 'completed-not-recovered':
        return `${action} completed without recovery`;
      case 'recovered':
        return `${action} recovered`;
      default:
        return assertNever(result.outcome);
    }
  }

  private latestRecoveryAttempt(): LocalAiPublicRecoveryAttempt | undefined {
    return this.store.recoveryAttempts()
      .filter((attempt) => attempt.targetId === this.status().targetId)
      .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
  }

  protected async runCheck(): Promise<void> {
    if (this.isBusy()) return;
    const result = await this.store.recheckTarget(this.status().targetId, 'lightweight');
    this.announcement.set(result ? 'Manual health check completed.' : 'Manual health check failed.');
  }

  protected async pause(): Promise<void> {
    await this.setLifecycle('paused', undefined, 'Target paused.');
  }

  protected async pauseForOneHour(): Promise<void> {
    await this.setLifecycle(
      'paused',
      { pausedUntil: this.clock() + 3_600_000 },
      'Target paused for one hour.',
    );
  }

  protected async resume(): Promise<void> {
    await this.setLifecycle('enrolled', undefined, 'Target resumed. A fresh check is required.');
  }

  protected requestRetirement(): void {
    this.retirementError.set(false);
    this.modal.open(this.retirementModalKey());
    afterNextRender(
      () => this.host.nativeElement
        .querySelector<HTMLButtonElement>('.confirm-dialog button')
        ?.focus(),
      { injector: this.injector },
    );
  }

  protected cancelRetirement(): void {
    this.modal.closeAndRestore(
      this.retirementModalKey(),
      () => this.host.nativeElement.querySelector<HTMLButtonElement>('.target-actions .danger'),
      ['next-target-action', 'enrol-target', 'page-heading'],
    );
  }

  protected async retire(): Promise<void> {
    if (this.isBusy()) return;
    const result = await this.store.setTargetLifecycle(this.status().targetId, 'retired');
    if (result) {
      this.modal.closeAndRestore(
        this.retirementModalKey(),
        undefined,
        ['next-target-action', 'enrol-target', 'page-heading'],
      );
      this.retired.emit();
    } else {
      this.retirementError.set(true);
    }
    this.announcement.set(result ? 'Target retired.' : 'Target retirement failed.');
  }

  private async setLifecycle(
    lifecycle: 'enrolled' | 'paused',
    options: LocalAiTargetLifecycleOptions | undefined,
    successMessage: string,
  ): Promise<void> {
    if (this.isBusy()) return;
    const result = options === undefined
      ? await this.store.setTargetLifecycle(this.status().targetId, lifecycle)
      : await this.store.setTargetLifecycle(this.status().targetId, lifecycle, options);
    this.announcement.set(result ? successMessage : 'Target lifecycle update failed.');
  }

  private newestLayerTimestamp(ok: boolean): number | null {
    const values = Object.values(this.status().layers)
      .filter((result): result is LocalAiProbeResult => Boolean(result) && result?.ok === ok)
      .map((result) => result.checkedAt);
    return values.length ? Math.max(...values) : null;
  }

  private stringArrayEvidence(
    result: LocalAiProbeResult | undefined,
    key: 'missingModels' | 'advertisedModels',
  ): string[] {
    const value: LocalAiProbeEvidenceValue | undefined = result?.evidence[key];
    return Array.isArray(value) ? value : [];
  }

  private actionLabel(action: string): string {
    return action.split('-').map(capitalize).join(' ');
  }

  private retirementModalKey(): string {
    return `retire:${this.status().targetId}`;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Local AI repair outcome: ${String(value)}`);
}
