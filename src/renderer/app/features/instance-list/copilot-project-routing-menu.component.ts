/**
 * "Copilot account" section of a project's three-dots menu.
 *
 * Mapping a repository to a GitHub account belongs where the project is, not
 * buried in Settings — you are looking at the project when you form the
 * intention. This resolves the project's current account, shows it, and maps it
 * in one click.
 *
 * It picks the RULE SHAPE for you: a repository with a GitHub remote gets an
 * owner rule (so every sibling repo in that org follows), and a checkout with
 * no remote gets a protected folder rule. Asking a user to choose between
 * "owner", "repository" and "path prefix" is asking them to learn the
 * resolver's precedence ladder, which is our problem, not theirs.
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
  type CopilotAccountRuleView,
  type CopilotAccountView,
} from '../../core/services/ipc/copilot-account-ipc.service';
import type { CopilotRouteOutcome } from '../../../../shared/types/copilot-account.types';

@Component({
  standalone: true,
  selector: 'app-copilot-project-routing-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="project-menu-divider"></div>
      <div class="copilot-section-label">
        Copilot account
        @if (summary(); as text) {
          <span class="copilot-current">{{ text }}</span>
        }
      </div>

      @for (account of accounts(); track account.id) {
        <button
          type="button"
          class="project-menu-item"
          role="menuitem"
          [disabled]="busy()"
          (click)="mapTo(account, $event)"
        >
          <span class="copilot-tick" aria-hidden="true">{{
            account.id === activeProfileId() ? '✓' : ''
          }}</span>{{ account.label }}
        </button>
      }

      @if (mappedRules().length > 0) {
        <button
          type="button"
          class="project-menu-item"
          role="menuitem"
          [disabled]="busy()"
          (click)="clearMapping($event)"
        >
          Clear this project's mapping
        </button>
      }

      @if (error(); as message) {
        <div class="copilot-error" role="alert">{{ message }}</div>
      }
    }
  `,
  styles: [`
    .copilot-section-label {
      display: flex; flex-direction: column; gap: 1px;
      padding: 6px 12px 2px; font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--text-secondary);
    }
    .copilot-current { text-transform: none; letter-spacing: 0; font-size: 11px; }
    .copilot-error { padding: 4px 12px 6px; font-size: 11px; color: var(--error-color, #d33); }
    /* Fixed-width gutter keeps the labels aligned whether or not a tick shows,
       without leaning on padding characters in the template. */
    .copilot-tick { display: inline-block; width: 12px; }
  `],
})
export class CopilotProjectRoutingMenuComponent {
  private readonly ipc = inject(CopilotAccountIpcService);

  /** Absolute path of the project this menu belongs to. */
  readonly projectPath = input<string | null>(null);
  /** Emitted after a successful change so the host can close the menu. */
  readonly mapped = output<void>();

  private readonly accountsSignal = signal<CopilotAccountView[]>([]);
  private readonly rulesSignal = signal<CopilotAccountRuleView[]>([]);
  private readonly outcomeSignal = signal<CopilotRouteOutcome | null>(null);
  private readonly busySignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  private loadedFor: string | null = null;

  readonly accounts = this.accountsSignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();

  /**
   * Hidden entirely until a second account exists. With one account there is
   * nothing to choose between, and an inert menu item is just noise.
   */
  readonly visible = computed(() => this.accountsSignal().length > 1);

  readonly activeProfileId = computed(() => {
    const outcome = this.outcomeSignal();
    return outcome?.ok ? outcome.route.profileId : null;
  });

  readonly summary = computed(() => {
    const outcome = this.outcomeSignal();
    if (!outcome) return null;
    if (!outcome.ok) return 'Blocked — open Settings to fix';
    const route = outcome.route;
    return route.source === 'default'
      ? `${route.profileLabel ?? route.profileId} (default)`
      : (route.profileLabel ?? route.profileId);
  });

  /** Rules that specifically target this project (not inherited defaults). */
  readonly mappedRules = computed(() => {
    const outcome = this.outcomeSignal();
    const ruleId = outcome?.ok ? outcome.route.ruleId : undefined;
    return ruleId ? this.rulesSignal().filter((rule) => rule.id === ruleId) : [];
  });

  constructor() {
    // The host renders this only while the menu is open, so construction IS
    // the open event — no host wiring, and nothing is fetched for the dozens of
    // projects whose menus are never opened.
    effect(() => {
      const path = this.projectPath();
      if (path) {
        void this.load();
      }
    });
  }

  /** Idempotent per path; safe to call repeatedly. */
  async load(): Promise<void> {
    const path = this.projectPath();
    if (!path || this.loadedFor === path) {
      return;
    }
    this.loadedFor = path;
    this.busySignal.set(true);
    try {
      const [accounts, rules, outcome] = await Promise.all([
        this.ipc.list(),
        this.ipc.listRules(),
        this.ipc.previewRoute({ workingDirectory: path }),
      ]);
      this.accountsSignal.set(accounts);
      this.rulesSignal.set(rules);
      this.outcomeSignal.set(outcome);
    } catch {
      this.errorSignal.set('Could not read Copilot accounts.');
    } finally {
      this.busySignal.set(false);
    }
  }

  async mapTo(account: CopilotAccountView, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const path = this.projectPath();
    if (!path) return;

    this.busySignal.set(true);
    this.errorSignal.set(null);
    try {
      const remotes = await this.ipc.suggestRules(path);
      // Prefer an OWNER rule: mapping one repo of an employer's org almost
      // always means "and the rest of them too", and a per-repo rule would
      // leave the siblings silently on the personal account.
      const remote = remotes[0];
      const response = remote
        ? await this.ipc.createRule({
            profileId: account.id,
            matcher: { type: 'owner', host: remote.host, owner: remote.owner },
          })
        : await this.ipc.createRule({
            profileId: account.id,
            // No remote to key off, so pin by location — and protect it, so a
            // failure here blocks rather than falling back to the default.
            matcher: { type: 'path-prefix', canonicalPath: path },
            isProtected: true,
          });
      if (!response.success) {
        this.errorSignal.set(response.error?.message ?? 'That mapping could not be saved.');
        return;
      }
      this.loadedFor = null;
      await this.load();
      this.mapped.emit();
    } catch (error) {
      this.errorSignal.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busySignal.set(false);
    }
  }

  async clearMapping(event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const rules = this.mappedRules();
    if (rules.length === 0) return;

    this.busySignal.set(true);
    this.errorSignal.set(null);
    try {
      for (const rule of rules) {
        const response = await this.ipc.removeRule(rule.id);
        if (!response.success) {
          this.errorSignal.set(response.error?.message ?? 'That rule could not be removed.');
          return;
        }
      }
      this.loadedFor = null;
      await this.load();
      this.mapped.emit();
    } finally {
      this.busySignal.set(false);
    }
  }
}
