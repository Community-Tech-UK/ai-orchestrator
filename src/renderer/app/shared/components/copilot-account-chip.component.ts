/**
 * Which GitHub Copilot account this session will use, and why.
 *
 * Two jobs, both from spec §15.2:
 *
 *  1. Provenance BEFORE anything runs — "Enterprise · matched
 *     github.com/owner/repo" — so a mis-mapped repository is obvious while it
 *     is still cheap to fix.
 *  2. An actionable blocked state. A routing failure is not "Copilot
 *     unavailable"; it is a specific thing the user can put right, so the exact
 *     remedy is rendered and `blocked` is emitted for the host to disable Start.
 *
 * Renders nothing at all for any other provider, so hosts can embed it
 * unconditionally.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  CopilotAccountIpcService,
  type CopilotAccountView,
} from '../../core/services/ipc/copilot-account-ipc.service';
import type {
  CopilotInvocationOrigin,
  CopilotRouteOutcome,
} from '../../../../shared/types/copilot-account.types';

@Component({
  standalone: true,
  selector: 'app-copilot-account-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isCopilot()) {
      <div class="copilot-account-chip" [class.blocked]="isBlocked()" [class.compact]="compact()">
        @if (loading()) {
          <span class="text">Checking Copilot account…</span>
        } @else if (outcome(); as resolved) {
          @if (resolved.ok) {
            <span class="dot" aria-hidden="true"></span>
            <span class="text" [title]="reasonText()">{{ label() }}</span>
            @if (!compact() && accounts().length > 1) {
              <select
                class="override"
                aria-label="Copilot account for this session"
                [value]="overrideId()"
                (change)="onOverride($event)"
              >
                <option value="">Choose automatically</option>
                @for (account of accounts(); track account.id) {
                  <option [value]="account.id">{{ account.label }}</option>
                }
              </select>
            }
          } @else {
            <span class="dot blocked" aria-hidden="true"></span>
            <span class="text" role="alert">{{ resolved.detail }}</span>
          }
        }
      </div>
    }
  `,
  styles: [`
    .copilot-account-chip {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 3px 10px; border-radius: 999px; font-size: 12px;
      border: 1px solid var(--border-color); background: var(--bg-secondary);
      max-width: 100%;
    }
    .copilot-account-chip.compact { padding: 1px 8px; font-size: 11px; }
    .copilot-account-chip.blocked { border-color: var(--error-color, #d33); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success-color, #4a9); }
    .dot.blocked { background: var(--error-color, #d33); }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .override { font-size: 11px; background: transparent; border: 0; color: inherit; }
  `],
})
export class CopilotAccountChipComponent {
  private readonly ipc = inject(CopilotAccountIpcService);

  readonly provider = input<string | null>(null);
  readonly workingDirectory = input<string | null>(null);
  readonly origin = input<CopilotInvocationOrigin>('interactive');
  /** Header/detail placement: no override control, tighter padding. */
  readonly compact = input(false);

  /** The account this session will use, once resolved. */
  readonly accountResolved = output<string | null>();
  /** True while routing is unresolved — hosts disable Start on this. */
  readonly blocked = output<boolean>();

  private readonly outcomeSignal = signal<CopilotRouteOutcome | null>(null);
  private readonly accountsSignal = signal<CopilotAccountView[]>([]);
  private readonly loadingSignal = signal(false);
  private readonly overrideSignal = signal('');

  readonly outcome = this.outcomeSignal.asReadonly();
  readonly accounts = this.accountsSignal.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();
  readonly overrideId = this.overrideSignal.asReadonly();

  readonly isCopilot = computed(() => this.provider() === 'copilot');
  readonly isBlocked = computed(() => {
    const resolved = this.outcomeSignal();
    return resolved !== null && !resolved.ok;
  });

  readonly label = computed(() => {
    const resolved = this.outcomeSignal();
    if (!resolved?.ok) return '';
    const route = resolved.route;
    const name = route.profileLabel ?? route.profileId;
    return route.repository
      ? `${name} · matched ${route.repository.host}/${route.repository.owner}/${route.repository.repo}`
      : `${name} · ${this.sourceLabel(route.source)}`;
  });

  readonly reasonText = computed(() => {
    const resolved = this.outcomeSignal();
    if (!resolved?.ok) return '';
    return `Routing reason: ${this.sourceLabel(resolved.route.source)}`;
  });

  constructor() {
    // Re-resolve whenever the provider, workspace, or override changes. The
    // route is workspace-derived, so a directory change can move the account.
    effect(() => {
      const provider = this.provider();
      const workingDirectory = this.workingDirectory();
      const override = this.overrideSignal();
      if (provider !== 'copilot') {
        this.outcomeSignal.set(null);
        this.blocked.emit(false);
        this.accountResolved.emit(null);
        return;
      }
      void this.resolve(workingDirectory, override);
    });
  }

  onOverride(event: Event): void {
    this.overrideSignal.set((event.target as HTMLSelectElement).value);
  }

  private sourceLabel(source: string): string {
    switch (source) {
      case 'explicit':
        return 'you chose this account';
      case 'repository':
        return 'matched this repository';
      case 'owner':
        return 'matched this GitHub owner';
      case 'path-prefix':
        return 'matched this folder';
      case 'persisted':
        return 'the account this conversation started on';
      case 'legacy':
        return 'your existing Copilot sign-in';
      default:
        return 'the default account';
    }
  }

  private async resolve(workingDirectory: string | null, override: string): Promise<void> {
    this.loadingSignal.set(true);
    try {
      const [outcome, accounts] = await Promise.all([
        this.ipc.previewRoute({
          ...(workingDirectory ? { workingDirectory } : {}),
          ...(override ? { explicitProfileId: override } : {}),
          origin: this.origin(),
        }),
        this.accountsSignal().length > 0 ? Promise.resolve(this.accountsSignal()) : this.ipc.list(),
      ]);
      this.accountsSignal.set(accounts);
      this.outcomeSignal.set(outcome);
      this.blocked.emit(outcome !== null && !outcome.ok);
      this.accountResolved.emit(outcome?.ok ? outcome.route.profileId : null);
    } finally {
      this.loadingSignal.set(false);
    }
  }
}
