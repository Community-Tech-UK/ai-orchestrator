/**
 * GitHub Copilot Accounts settings section.
 *
 * Where James decides which GitHub identity serves which repository. The core
 * idea the UI has to make obvious: a Copilot account is chosen from the
 * workspace, before anything runs, and a scope that cannot be resolved BLOCKS
 * rather than quietly falling back to the personal account.
 *
 * Sign-in is deliberately not something this component can complete: it opens a
 * terminal running `copilot login` with that profile's own state directory.
 * Harness never sees the token.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  CopilotAccountIpcService,
  type CopilotAccountDiagnosticsView,
  type CopilotAccountRuleView,
  type CopilotAccountView,
  type CopilotRemoteSuggestion,
  type DiscoveredCopilotAccount,
} from '../../core/services/ipc/copilot-account-ipc.service';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import type { RecentDirectoryEntry } from '../../../../shared/types/recent-directories.types';
import type {
  CopilotAccountKind,
  CopilotAutomationPolicy,
  CopilotRouteOutcome,
  CopilotRoutingMatcher,
} from '../../../../shared/types/copilot-account.types';

interface RuleGroup {
  profile: CopilotAccountView;
  rules: CopilotAccountRuleView[];
}

@Component({
  standalone: true,
  selector: 'app-copilot-accounts-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="copilot-accounts-tab">
      <div class="tab-header">
        <div>
          <h3 class="section-title">GitHub Copilot accounts</h3>
          <p class="section-desc">
            Decide which GitHub account Copilot uses for which repositories. Each
            account signs in separately and keeps its own Copilot state, so two
            sessions can run side by side under different accounts without one
            switching the other. Only you can change these — agents cannot.
          </p>
        </div>
        <div class="header-actions">
          <button type="button" class="btn btn-secondary" (click)="refresh()" [disabled]="busy()">
            {{ busy() ? 'Working…' : 'Refresh' }}
          </button>
        </div>
      </div>

      @if (error(); as message) {
        <p class="error-banner" role="alert">{{ message }}</p>
      }

      @for (warning of diagnosticsWarnings(); track warning) {
        <p class="warning-banner">{{ warning }}</p>
      }

      @if (accounts().length === 0) {
        <p class="empty-state">
          No accounts are set up yet, so Copilot keeps using the single sign-in it
          already has. Add an account below to start routing by repository.
        </p>
      }

      <section class="accounts">
        @for (account of accounts(); track account.id) {
          <article class="account-card" [class.is-default]="account.isDefault">
            <header>
              <div class="account-title">
                <strong>{{ account.label }}</strong>
                <span class="chip kind">{{ account.accountKind }}</span>
                @if (account.isDefault) {
                  <span class="chip default">Default</span>
                }
                @if (account.isLegacy) {
                  <span class="chip legacy">Existing sign-in</span>
                }
              </div>
              <span class="chip binding" [attr.data-state]="account.binding?.state ?? 'unavailable'">
                {{ bindingLabel(account) }}
              </span>
            </header>

            <dl class="account-facts">
              <div>
                <dt>Signed in as</dt>
                <dd>{{ account.expectedLogin ?? 'Not signed in yet' }}</dd>
              </div>
              <div>
                <dt>GitHub host</dt>
                <dd>{{ account.host }}</dd>
              </div>
              <div>
                <dt>Unmatched workspaces</dt>
                <dd>
                  {{
                    account.scopePolicy === 'default-eligible'
                      ? 'May use this account'
                      : 'Only repositories you map here'
                  }}
                </dd>
              </div>
              <div>
                <dt>Automatic use</dt>
                <dd>
                  <select
                    [ngModel]="account.automationPolicy"
                    (ngModelChange)="setAutomationPolicy(account, $event)"
                    [disabled]="busy()"
                  >
                    <option value="allow-routed">Allowed once a repository matches</option>
                    <option value="manual-only">Only when I start the session</option>
                    <option value="disabled">Never</option>
                  </select>
                </dd>
              </div>
            </dl>

            @if (account.binding?.state === 'identity-mismatch') {
              <p class="mismatch">
                This account is signed in as
                <strong>{{ account.binding?.observedLogin ?? 'someone else' }}</strong>, not
                {{ account.expectedLogin }}. Copilot is blocked for it until this is resolved.
                <button
                  type="button"
                  class="btn btn-secondary"
                  (click)="adoptObserved(account)"
                  [disabled]="busy() || !account.binding?.observedLogin"
                >
                  Use {{ account.binding?.observedLogin }} instead
                </button>
              </p>
            }

            @if (account.binding?.storesTokenPlaintext) {
              <p class="mismatch">
                This account is set to store its token in a plain file rather than the
                system keychain. Turn that off in its Copilot settings and sign in again.
              </p>
            }

            <div class="account-actions">
              <button type="button" class="btn" (click)="signIn(account)" [disabled]="busy()">
                {{ account.expectedLogin ? 'Sign in again' : 'Sign in' }}
              </button>
              <button
                type="button"
                class="btn btn-secondary"
                (click)="verify(account)"
                [disabled]="busy()"
              >
                Check sign-in
              </button>
              <button
                type="button"
                class="btn btn-secondary"
                (click)="rename(account)"
                [disabled]="busy()"
              >
                Rename
              </button>
              <button
                type="button"
                class="btn btn-secondary"
                (click)="setDefault(account)"
                [disabled]="busy() || account.isDefault || account.scopePolicy !== 'default-eligible'"
              >
                Make default
              </button>
              <button
                type="button"
                class="btn btn-danger"
                (click)="remove(account)"
                [disabled]="busy()"
              >
                Remove
              </button>
            </div>

            <div class="rules">
              <h4>Repositories and folders routed here</h4>
              @if (rulesFor(account.id).length === 0) {
                <p class="empty-rules">Nothing is mapped to this account yet.</p>
              }
              @for (rule of rulesFor(account.id); track rule.id) {
                <div class="rule-row">
                  <span class="rule-target">{{ describeMatcher(rule.matcher) }}</span>
                  @if (rule.isProtected) {
                    <span class="chip protected" title="A failed match here blocks Copilot rather than falling back">
                      Protected
                    </span>
                  }
                  <button
                    type="button"
                    class="btn btn-link"
                    (click)="removeRule(rule)"
                    [disabled]="busy()"
                  >
                    Remove
                  </button>
                </div>
              }
            </div>
          </article>
        }
      </section>

      @if (discovered().length > 0) {
        <section class="discovered">
          <h4>Already signed in to Copilot on this Mac</h4>
          <p class="hint">
            Add one and Harness gives it its own isolated Copilot state. Your
            sign-in is already stored, so this is a one-time setup step — not a
            fresh login.
          </p>
          @for (candidate of discovered(); track candidate.login) {
            <div class="rule-row">
              <span class="rule-target">{{ candidate.login }}</span>
              <span class="chip">{{ candidate.host }}</span>
              @if (candidate.alreadyAdded) {
                <span class="chip">Already added</span>
              } @else {
                <button
                  type="button"
                  class="btn"
                  (click)="addDiscovered(candidate)"
                  [disabled]="busy()"
                >
                  Add {{ candidate.login }}
                </button>
              }
            </div>
          }
        </section>
      }

      <section class="add-account">
        <h4>Add an account manually</h4>
        <div class="add-row">
          <input
            type="text"
            [(ngModel)]="newLabel"
            placeholder="Name it, e.g. Work"
            [disabled]="busy()"
          />
          <select [(ngModel)]="newKind" [disabled]="busy()">
            <option value="personal">Personal</option>
            <option value="enterprise">Work / enterprise</option>
          </select>
          <input
            type="text"
            [(ngModel)]="newHost"
            placeholder="github.com"
            [disabled]="busy()"
          />
          <button type="button" class="btn" (click)="addAccount()" [disabled]="busy() || !newLabel.trim()">
            Add
          </button>
        </div>
        <p class="hint">
          A work account starts out usable only for repositories you map to it, so
          it can never pick up unrelated work by accident.
        </p>
      </section>

      <section class="route-workspace">
        <h4>Route a workspace</h4>
        <p class="hint">
          Pick a folder you have worked in, or paste any path. Harness reads its
          GitHub remotes and offers the mapping — you do not have to know the
          owner or repository name.
        </p>
        <div class="add-row">
          @if (recentWorkspaces().length > 0) {
            <select
              aria-label="Recent workspace"
              [ngModel]="workspacePath"
              (ngModelChange)="onWorkspacePicked($event)"
              [disabled]="busy()"
            >
              <option value="">Choose a recent folder…</option>
              @for (entry of recentWorkspaces(); track entry.path) {
                <option [value]="entry.path">{{ entry.displayName }} — {{ entry.path }}</option>
              }
            </select>
          }
          <input
            type="text"
            [(ngModel)]="workspacePath"
            placeholder="/path/to/your/checkout"
            [disabled]="busy()"
          />
          <button
            type="button"
            class="btn btn-secondary"
            (click)="inspectWorkspace()"
            [disabled]="busy() || !workspacePath.trim()"
          >
            Check
          </button>
        </div>

        @if (checkedWorkspace() && remoteSuggestions().length === 0 && !busy()) {
          <p class="hint">
            No GitHub remote was found here. Use
            <strong>Protect this folder and everything under it</strong> below to
            route it by location instead — that is the right option for a
            checkout with no remote yet.
          </p>
        }

        @if (routePreview(); as outcome) {
          <p class="route-preview" [class.blocked]="!outcome.ok">
            {{ describeRoute(outcome) }}
          </p>
        }

        @for (remote of remoteSuggestions(); track remote.displayPath) {
          <div class="rule-row">
            <span class="rule-target">{{ remote.host }}/{{ remote.displayPath }}</span>
            <select [(ngModel)]="suggestionTargets[remote.displayPath]" [disabled]="busy()">
              <option value="">Choose an account…</option>
              @for (account of accounts(); track account.id) {
                <option [value]="account.id">{{ account.label }}</option>
              }
            </select>
            <button
              type="button"
              class="btn btn-link"
              (click)="addRepositoryRule(remote)"
              [disabled]="busy() || !suggestionTargets[remote.displayPath]"
            >
              Route this repository
            </button>
            <button
              type="button"
              class="btn btn-link"
              (click)="addOwnerRule(remote)"
              [disabled]="busy() || !suggestionTargets[remote.displayPath]"
            >
              Route everything under {{ remote.owner }}
            </button>
          </div>
        }

        <div class="add-row">
          <select [(ngModel)]="pathRuleProfileId" [disabled]="busy()">
            <option value="">Choose an account…</option>
            @for (account of accounts(); track account.id) {
              <option [value]="account.id">{{ account.label }}</option>
            }
          </select>
          <button
            type="button"
            class="btn btn-link"
            (click)="addPathRule()"
            [disabled]="busy() || !pathRuleProfileId || !workspacePath.trim()"
          >
            Protect this folder and everything under it
          </button>
        </div>
      </section>
    </div>
  `,
  styles: [`
    .copilot-accounts-tab { display: flex; flex-direction: column; gap: 20px; }
    .tab-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .section-desc { color: var(--text-secondary); margin: 4px 0 0; max-width: 68ch; }
    .error-banner, .warning-banner {
      margin: 0; padding: 8px 12px; border-radius: 6px;
      border: 1px solid var(--border-color); background: var(--bg-secondary);
    }
    .error-banner { border-color: var(--error-color, #d33); }
    .empty-state, .hint, .empty-rules { color: var(--text-secondary); margin: 4px 0 0; }
    .accounts { display: flex; flex-direction: column; gap: 16px; }
    .discovered { border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; }
    .account-card {
      border: 1px solid var(--border-color); border-radius: 8px; padding: 14px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .account-card.is-default { border-color: var(--accent-color, #4a9); }
    .account-card header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .account-title { display: flex; align-items: center; gap: 8px; }
    .chip {
      font-size: 11px; padding: 2px 8px; border-radius: 999px;
      border: 1px solid var(--border-color); text-transform: capitalize;
    }
    .chip.binding[data-state='authenticated'] { border-color: var(--success-color, #4a9); }
    .chip.binding[data-state='identity-mismatch'] { border-color: var(--error-color, #d33); }
    .account-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin: 0; }
    .account-facts dt { font-size: 11px; color: var(--text-secondary); }
    .account-facts dd { margin: 2px 0 0; }
    .mismatch { margin: 0; color: var(--text-primary); }
    .account-actions, .add-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .rules { border-top: 1px solid var(--border-color); padding-top: 10px; }
    .rules h4, .add-account h4, .route-workspace h4 { margin: 0 0 8px; font-size: 13px; }
    .rule-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; flex-wrap: wrap; }
    .rule-target { font-family: var(--font-mono, monospace); font-size: 12px; }
    .route-preview { padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary); }
    .route-preview.blocked { border: 1px solid var(--error-color, #d33); }
  `],
})
export class CopilotAccountsTabComponent implements OnInit {
  private readonly ipc = inject(CopilotAccountIpcService);
  private readonly recentDirectories = inject(RecentDirectoriesIpcService);

  private readonly accountsSignal = signal<CopilotAccountView[]>([]);
  private readonly rulesSignal = signal<CopilotAccountRuleView[]>([]);
  private readonly diagnosticsSignal = signal<CopilotAccountDiagnosticsView | null>(null);
  private readonly busySignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  private readonly routePreviewSignal = signal<CopilotRouteOutcome | null>(null);
  private readonly remoteSuggestionsSignal = signal<CopilotRemoteSuggestion[]>([]);
  private readonly discoveredSignal = signal<DiscoveredCopilotAccount[]>([]);
  private readonly recentWorkspacesSignal = signal<RecentDirectoryEntry[]>([]);
  /** Set once Check has run, so "no remotes" can be distinguished from "not asked yet". */
  private readonly checkedWorkspaceSignal = signal(false);

  readonly accounts = this.accountsSignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();
  readonly routePreview = this.routePreviewSignal.asReadonly();
  readonly remoteSuggestions = this.remoteSuggestionsSignal.asReadonly();
  /** Accounts Copilot is already signed in to that have no profile here yet. */
  readonly discovered = this.discoveredSignal.asReadonly();
  readonly recentWorkspaces = this.recentWorkspacesSignal.asReadonly();
  readonly checkedWorkspace = this.checkedWorkspaceSignal.asReadonly();
  readonly diagnosticsWarnings = computed(() => this.diagnosticsSignal()?.warnings ?? []);

  /** Grouped for the template; rules always render under their own account. */
  readonly ruleGroups = computed<RuleGroup[]>(() =>
    this.accountsSignal().map((profile) => ({
      profile,
      rules: this.rulesSignal().filter((rule) => rule.profileId === profile.id),
    })),
  );

  newLabel = '';
  newKind: CopilotAccountKind = 'personal';
  newHost = '';
  workspacePath = '';
  pathRuleProfileId = '';
  suggestionTargets: Record<string, string> = {};

  ngOnInit(): void {
    void this.refresh();
    void this.loadRecentWorkspaces();
  }

  private async loadRecentWorkspaces(): Promise<void> {
    try {
      // Local folders only: a remote node's path is not inspectable from here,
      // and offering one would produce a confusing "no remotes found".
      const entries = await this.recentDirectories.getDirectories({ limit: 25 });
      this.recentWorkspacesSignal.set(
        entries.filter((entry) => !entry.nodeId || entry.nodeId === 'local'),
      );
    } catch {
      // A missing recents list just means the picker is hidden.
      this.recentWorkspacesSignal.set([]);
    }
  }

  /** Picking a recent folder fills the path and checks it immediately. */
  onWorkspacePicked(path: string): void {
    this.workspacePath = path;
    if (path) {
      void this.inspectWorkspace();
    }
  }

  rulesFor(profileId: string): CopilotAccountRuleView[] {
    return this.rulesSignal().filter((rule) => rule.profileId === profileId);
  }

  bindingLabel(account: CopilotAccountView): string {
    switch (account.binding?.state) {
      case 'authenticated':
        return `Signed in${account.binding.observedLogin ? ` as ${account.binding.observedLogin}` : ''}`;
      case 'identity-mismatch':
        return 'Wrong account signed in';
      case 'unavailable':
        return 'Could not check';
      default:
        return 'Not signed in';
    }
  }

  describeMatcher(matcher: CopilotRoutingMatcher): string {
    switch (matcher.type) {
      case 'repository':
        return `${matcher.host}/${matcher.owner}/${matcher.repo}`;
      case 'owner':
        return `${matcher.host}/${matcher.owner}/*`;
      case 'path-prefix':
        return `${matcher.canonicalPath} (and everything under it)`;
    }
  }

  describeRoute(outcome: CopilotRouteOutcome): string {
    if (outcome.ok) {
      const reason =
        outcome.route.repository
          ? `matched ${outcome.route.repository.host}/${outcome.route.repository.owner}/${outcome.route.repository.repo}`
          : `chosen by ${outcome.route.source}`;
      return `${outcome.route.profileLabel ?? outcome.route.profileId} · ${reason}`;
    }
    return `Blocked: ${outcome.detail}`;
  }

  async refresh(): Promise<void> {
    await this.run(async () => {
      const [accounts, rules, diagnostics, discovered] = await Promise.all([
        this.ipc.list(),
        this.ipc.listRules(),
        this.ipc.diagnostics(),
        this.ipc.discover(),
      ]);
      this.accountsSignal.set(accounts);
      this.rulesSignal.set(rules);
      this.diagnosticsSignal.set(diagnostics);
      this.discoveredSignal.set(discovered);
    });
  }

  /**
   * Add an account Copilot is already signed in to.
   *
   * Pre-fills the identity from what Copilot already knows, so the host and
   * login cannot be mistyped — those are exactly the fields identity
   * verification then checks, and a typo there reads as a mismatch.
   */
  async addDiscovered(candidate: DiscoveredCopilotAccount): Promise<void> {
    await this.mutate(() =>
      this.ipc.create({
        label: candidate.login,
        // An account discovered this way is almost always the second one, so it
        // starts matched-only — it cannot pick up unrelated repositories until
        // you map something to it.
        accountKind: this.accountsSignal().length === 0 ? 'personal' : 'enterprise',
        host: candidate.host,
        makeDefault: this.accountsSignal().length === 0,
      }),
    );
  }

  async addAccount(): Promise<void> {
    const label = this.newLabel.trim();
    if (!label) return;
    await this.mutate(() =>
      this.ipc.create({
        label,
        accountKind: this.newKind,
        ...(this.newHost.trim() ? { host: this.newHost.trim().toLowerCase() } : {}),
        // The first account added becomes the default so an unmatched workspace
        // still has somewhere to go; later ones do not silently take over.
        makeDefault: this.accountsSignal().length === 0 && this.newKind === 'personal',
      }),
    );
    this.newLabel = '';
    this.newHost = '';
  }

  async rename(account: CopilotAccountView): Promise<void> {
    const label = globalThis.prompt?.('New name for this account', account.label)?.trim();
    if (!label || label === account.label) return;
    await this.mutate(() => this.ipc.rename(account.id, label));
  }

  async setAutomationPolicy(
    account: CopilotAccountView,
    automationPolicy: CopilotAutomationPolicy,
  ): Promise<void> {
    if (automationPolicy === account.automationPolicy) return;
    await this.mutate(() => this.ipc.updatePolicy(account.id, { automationPolicy }));
  }

  async setDefault(account: CopilotAccountView): Promise<void> {
    await this.mutate(() => this.ipc.setDefault(account.id));
  }

  async remove(account: CopilotAccountView): Promise<void> {
    const confirmed = globalThis.confirm?.(
      `Remove "${account.label}"? Existing conversations that used it will no longer resume. `
      + 'This does not sign you out of GitHub or delete the account itself.',
    );
    if (!confirmed) return;
    await this.mutate(() => this.ipc.remove(account.id));
  }

  async verify(account: CopilotAccountView): Promise<void> {
    await this.mutate(() => this.ipc.verifyBinding(account.id));
  }

  async adoptObserved(account: CopilotAccountView): Promise<void> {
    const login = account.binding?.observedLogin;
    if (!login) return;
    await this.mutate(() =>
      this.ipc.adoptIdentity(account.id, login, account.binding?.observedHost),
    );
  }

  async signIn(account: CopilotAccountView): Promise<void> {
    await this.mutate(() => this.ipc.signIn(account.id, account.host), { refresh: false });
  }

  async inspectWorkspace(): Promise<void> {
    const workingDirectory = this.workspacePath.trim();
    if (!workingDirectory) return;
    await this.run(async () => {
      const [outcome, remotes] = await Promise.all([
        this.ipc.previewRoute({ workingDirectory }),
        this.ipc.suggestRules(workingDirectory),
      ]);
      this.routePreviewSignal.set(outcome);
      this.remoteSuggestionsSignal.set(remotes);
      this.checkedWorkspaceSignal.set(true);
    });
  }

  async addRepositoryRule(remote: CopilotRemoteSuggestion): Promise<void> {
    const profileId = this.suggestionTargets[remote.displayPath];
    if (!profileId) return;
    await this.mutate(() =>
      this.ipc.createRule({
        profileId,
        matcher: {
          type: 'repository',
          host: remote.host,
          owner: remote.owner,
          repo: remote.repo,
        },
      }),
    );
  }

  async addOwnerRule(remote: CopilotRemoteSuggestion): Promise<void> {
    const profileId = this.suggestionTargets[remote.displayPath];
    if (!profileId) return;
    await this.mutate(() =>
      this.ipc.createRule({
        profileId,
        matcher: { type: 'owner', host: remote.host, owner: remote.owner },
      }),
    );
  }

  async addPathRule(): Promise<void> {
    const canonicalPath = this.workspacePath.trim();
    if (!this.pathRuleProfileId || !canonicalPath) return;
    await this.mutate(() =>
      this.ipc.createRule({
        profileId: this.pathRuleProfileId,
        matcher: { type: 'path-prefix', canonicalPath },
        // A folder rule is how work checked out before an origin exists gets
        // protected, so it is protected by default.
        isProtected: true,
      }),
    );
  }

  async removeRule(rule: CopilotAccountRuleView): Promise<void> {
    await this.mutate(() => this.ipc.removeRule(rule.id));
  }

  private async mutate(
    action: () => Promise<{ success: boolean; error?: { message?: string } }>,
    options: { refresh?: boolean } = {},
  ): Promise<void> {
    await this.run(async () => {
      const response = await action();
      if (!response.success) {
        throw new Error(response.error?.message ?? 'That change could not be applied.');
      }
      if (options.refresh !== false) {
        const [accounts, rules, diagnostics, discovered] = await Promise.all([
          this.ipc.list(),
          this.ipc.listRules(),
          this.ipc.diagnostics(),
          this.ipc.discover(),
        ]);
        this.accountsSignal.set(accounts);
        this.rulesSignal.set(rules);
        this.diagnosticsSignal.set(diagnostics);
        this.discoveredSignal.set(discovered);
      }
    });
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busySignal.set(true);
    this.errorSignal.set(null);
    try {
      await work();
    } catch (error) {
      this.errorSignal.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busySignal.set(false);
    }
  }
}
