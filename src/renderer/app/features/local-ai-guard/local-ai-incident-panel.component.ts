import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import type {
  LocalAiIncident,
  LocalAiRepairAction,
  LocalAiRepairResult,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LocalAiModalCoordinator } from './local-ai-modal-coordinator';

const ACTION_LABELS: Record<LocalAiRepairAction, string> = {
  'recheck-layer': 'Recheck failed layer',
  'deep-check': 'Deep check',
  'validate-models': 'Validate models',
  'reconnect-worker': 'Reconnect worker',
  'restart-ollama': 'Restart Ollama',
};

@Component({
  selector: 'app-local-ai-incident-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="incident" [attr.data-severity]="incident().severity">
      <span class="visually-hidden" aria-live="polite" aria-atomic="true">{{ announcement() }}</span>
      <header>
        <div>
          <p class="eyebrow">{{ incident().severity }} incident</p>
          <h3>{{ failureLabel() }}</h3>
          <p>
            {{ incident().affectedLayers.join(', ') }}
            · {{ incident().fallbackCount }} fallback{{ incident().fallbackCount === 1 ? '' : 's' }}
            · {{ costImpact() }}
          </p>
        </div>
        <span class="state">{{ incident().state }}</span>
      </header>

      <div class="incident-actions">
        @if (incident().state === 'open') {
          <button type="button" [disabled]="isBusy()" (click)="acknowledge()">Acknowledge</button>
        }
        <button type="button" [disabled]="isBusy()" (click)="diagnose()">Diagnose</button>
      </div>

      @if (diagnostic(); as report) {
        <section class="diagnosis" aria-label="Diagnosis and guided recovery">
          <h4>Recommended recovery</h4>
          <p>Actions are named and bounded. Guided actions show instructions without executing them.</p>
          <div class="recommendations">
            @for (action of report.recommendedActions; track action) {
              <div class="recommendation">
                <strong>{{ actionLabel(action) }}</strong>
                <button
                  type="button"
                  [disabled]="isBusy()"
                  (click)="runGuided(action)"
                >Show guided steps for {{ actionLabel(action) }}</button>
                @if (action === 'restart-ollama') {
                  <button
                    type="button"
                    class="danger"
                    [disabled]="isBusy() || !automaticRepairEnabled()"
                    (click)="requestAutomaticRestart()"
                  >Restart Ollama automatically</button>
                }
              </div>
            }
          </div>
          @if (!automaticRepairEnabled() && report.recommendedActions.includes('restart-ollama')) {
            <p class="guard-note">
              Enable automatic repair in target settings before this action can run.
            </p>
          }
        </section>
      }

      @if (repairResult(); as result) {
        <section class="result" [attr.data-recovered]="result.recovered">
          <strong>{{ actionLabel(result.action) }}</strong>
          <span>{{ safeRepairMessage(result.message) }}</span>
        </section>
      }

      @if (store.operationError()) {
        <p class="operation-error" role="alert">
          The recovery action could not be completed. Try again.
        </p>
      }

      @if (confirmingAutomaticRestart()) {
        <div class="dialog-backdrop">
          <section
            class="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            [attr.aria-labelledby]="'automatic-restart-title-' + incident().id"
            [attr.aria-describedby]="'automatic-restart-description-' + incident().id"
          >
            <h4 [id]="'automatic-restart-title-' + incident().id">Restart Ollama automatically?</h4>
            <p [id]="'automatic-restart-description-' + incident().id">
              This runs only the supported platform adapter, then verifies endpoint and canary health.
            </p>
            <div>
              <button type="button" (click)="cancelAutomaticRestart()">Cancel</button>
              <button type="button" class="danger" [disabled]="isBusy()" (click)="confirmAutomaticRestart()">
                Confirm automatic restart
              </button>
            </div>
          </section>
        </div>
      }
    </article>
  `,
  styles: [`
    :host { display: block; }
    .incident {
      position: relative;
      padding: var(--spacing-md);
      border: 1px solid var(--warning-border);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--warning-bg) 48%, var(--card-bg));
    }
    .incident[data-severity='critical'] { border-color: var(--error-border); }
    header {
      display: flex;
      justify-content: space-between;
      gap: var(--spacing-md);
    }
    .eyebrow,
    header p,
    .diagnosis p {
      margin: 0;
      color: var(--text-secondary);
      font-size: var(--text-xs);
    }
    .eyebrow { font-family: var(--font-mono); font-weight: 700; }
    h3, h4 { margin: 0.2rem 0; }
    .state {
      height: fit-content;
      padding: 0.2rem 0.55rem;
      border: 1px solid var(--pill-warn-border);
      border-radius: var(--radius-full);
      color: var(--pill-warn-fg);
      font-size: var(--text-xs);
      text-transform: capitalize;
    }
    .incident-actions,
    .recommendations,
    .recommendation,
    .result {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
    }
    .incident-actions { margin-top: var(--spacing-md); }
    .diagnosis {
      margin-top: var(--spacing-md);
      padding-top: var(--spacing-md);
      border-top: 1px solid var(--border-color);
    }
    .recommendations {
      margin-top: var(--spacing-sm);
      flex-direction: column;
    }
    .recommendation {
      align-items: center;
      padding: var(--spacing-sm);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
    }
    .recommendation strong { margin-right: auto; font-size: var(--text-sm); }
    button {
      min-height: 31px;
      padding: 0.3rem 0.65rem;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--glass-medium);
      color: var(--text-primary);
      font: inherit;
      font-size: var(--text-xs);
      font-weight: 650;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--glass-strong); }
    button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    button:disabled { cursor: default; opacity: 0.5; }
    button.danger { border-color: var(--pill-error-border); color: var(--pill-error-fg); }
    .guard-note {
      margin-top: var(--spacing-sm) !important;
      padding: var(--spacing-sm);
      border-left: 3px solid var(--warning-border);
      background: var(--warning-bg);
    }
    .result {
      margin-top: var(--spacing-md);
      padding: var(--spacing-sm);
      border: 1px solid var(--success-border);
      border-radius: var(--radius-sm);
      flex-direction: column;
      font-size: var(--text-sm);
    }
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
      width: min(440px, 100%);
      padding: var(--spacing-lg);
      border: 1px solid var(--error-border);
      border-radius: var(--card-radius);
      background: var(--bg-elevated);
      box-shadow: var(--shadow-lg);
    }
    .confirm-dialog p { color: var(--text-secondary); }
    .confirm-dialog div { display: flex; justify-content: flex-end; gap: var(--spacing-sm); }
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; animation: none !important; }
    }
  `],
})
export class LocalAiIncidentPanelComponent {
  protected readonly store = inject(LocalAiGuardStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly modal = inject(LocalAiModalCoordinator);

  readonly incident = input.required<LocalAiIncident>();
  readonly automaticRepairEnabled = input(false);
  protected readonly confirmingAutomaticRestart = computed(() =>
    this.modal.activeKey() === this.restartModalKey());
  protected readonly announcement = signal('');
  protected readonly isBusy = computed(() => this.store.operationKey() !== null);
  protected readonly diagnostic = computed(() =>
    this.store.diagnosticFor(this.incident().targetId));
  protected readonly repairResult = computed(() =>
    this.store.repairFor(this.incident().targetId));

  @HostListener('document:keydown', ['$event'])
  protected onDialogKeydown(event: KeyboardEvent): void {
    if (!this.confirmingAutomaticRestart()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelAutomaticRestart();
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

  protected failureLabel(): string {
    return this.incident().failureCode.split('-').map(capitalize).join(' ');
  }

  protected actionLabel(action: LocalAiRepairAction): string {
    return ACTION_LABELS[action];
  }

  protected costImpact(): string {
    if (this.incident().knownCostUsd > 0) {
      return `$${this.incident().knownCostUsd.toFixed(2)} measured`;
    }
    if (this.incident().estimatedCostUsd > 0) {
      return `$${this.incident().estimatedCostUsd.toFixed(2)} estimated`;
    }
    return 'no recorded cost';
  }

  protected async acknowledge(): Promise<void> {
    if (this.isBusy()) return;
    const result = await this.store.acknowledgeIncident(this.incident().id);
    this.announcement.set(result ? 'Incident acknowledged.' : 'Incident acknowledgement failed.');
  }

  protected async diagnose(): Promise<void> {
    if (this.isBusy()) return;
    const result = await this.store.diagnoseTarget(this.incident().targetId);
    this.announcement.set(result ? 'Diagnosis completed.' : 'Diagnosis could not be completed.');
  }

  protected async runGuided(action: LocalAiRepairAction): Promise<void> {
    if (this.isBusy()) return;
    const result = await this.store.repairTarget(this.incident().targetId, action, 'guided');
    this.announcement.set(
      !result
        ? 'Guidance failed.'
        : result.supported
          ? `${this.actionLabel(action)} guidance ready.`
          : `${this.actionLabel(action)} is not supported for this target.`,
    );
  }

  protected requestAutomaticRestart(): void {
    if (!this.automaticRepairEnabled() || this.isBusy()) return;
    this.modal.open(this.restartModalKey());
    queueMicrotask(() => {
      this.host.nativeElement.querySelector<HTMLButtonElement>('.confirm-dialog button')?.focus();
    });
  }

  protected cancelAutomaticRestart(): void {
    this.modal.closeAndRestore(
      this.restartModalKey(),
      () => this.automaticRestartButton(),
      ['next-incident-action', 'next-target-action', 'enrol-target', 'page-heading'],
    );
  }

  protected async confirmAutomaticRestart(): Promise<void> {
    if (!this.automaticRepairEnabled() || this.isBusy()) return;
    const trigger = this.automaticRestartButton();
    const result = await this.store.repairTarget(
      this.incident().targetId,
      'restart-ollama',
      'automatic',
    );
    this.modal.closeAndRestore(
      this.restartModalKey(),
      () => trigger,
      ['next-incident-action', 'next-target-action', 'enrol-target', 'page-heading'],
    );
    this.announcement.set(
      !result
        ? 'Automatic restart failed. No recovery result was received.'
        : this.automaticRepairAnnouncement(result),
    );
  }

  protected safeRepairMessage(message: string): string {
    return message
      .replace(/\bhttps?:\/\/\S+/gi, '[local endpoint]')
      .replace(/\bfile:\/\/\S+/gi, '[local path]');
  }

  private automaticRestartButton(): HTMLButtonElement | null {
    return Array.from(
      this.host.nativeElement.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'Restart Ollama automatically') ?? null;
  }

  private restartModalKey(): string {
    return `restart:${this.incident().id}`;
  }

  private automaticRepairAnnouncement(result: LocalAiRepairResult): string {
    switch (result.outcome) {
      case 'guided':
        return 'Automatic restart returned guidance without running.';
      case 'unsupported':
        return 'Automatic restart is not supported for this target.';
      case 'not-attempted':
        return 'Automatic restart did not run.';
      case 'execution-failed':
        return 'Automatic restart failed.';
      case 'completed-not-recovered':
        return 'Automatic restart ran, but health did not recover.';
      case 'recovered':
        return 'Automatic restart completed and health recovered.';
      default:
        return assertNever(result.outcome);
    }
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Local AI repair outcome: ${String(value)}`);
}
