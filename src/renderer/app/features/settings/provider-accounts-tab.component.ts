/**
 * Claude & Codex Accounts settings section (provider account pools).
 *
 * Where James adds the Claude and ChatGPT subscriptions he owns, orders them,
 * and decides what happens when one hits its usage limit. Each account signs
 * in through a terminal running the official CLI against that account's own
 * home; Harness never sees a token.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ProviderAccountIpcService,
  type ProviderAccountDoctorView,
  type ProviderAccountView,
} from '../../core/services/ipc/provider-account-ipc.service';
import type {
  AccountAutomationPolicy,
  AccountContinuationMode,
  AccountFailoverMode,
  PooledProvider,
  ProviderAccountPoolPolicy,
  ProviderAccountPools,
} from '../../../../shared/types/provider-account.types';

const PROVIDERS: readonly { id: PooledProvider; label: string; subscription: string }[] = [
  { id: 'claude', label: 'Claude', subscription: 'Claude' },
  { id: 'codex', label: 'Codex', subscription: 'ChatGPT' },
];

const SIGN_IN_POLL_MS = 5_000;
const SIGN_IN_POLL_LIMIT = 60;

@Component({
  standalone: true,
  selector: 'app-provider-accounts-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="provider-accounts-tab">
      <div class="tab-intro">
        <p class="section-desc">
          New sessions use the first available account in each list. Only you can change
          these settings; agents cannot.
        </p>
        <button type="button" class="btn btn-secondary" (click)="refresh()" [disabled]="busy()">
          {{ busy() ? 'Working…' : 'Refresh' }}
        </button>
      </div>

      @if (error(); as message) {
        <p class="error-banner" role="alert">{{ message }}</p>
      }
      @if (notice(); as message) {
        <p class="notice-banner" role="status">{{ message }}</p>
      }

      @for (provider of providers; track provider.id) {
        <section class="provider-section" [attr.data-provider]="provider.id">
          <h4 class="provider-title">{{ provider.label }}</h4>

          @for (warning of doctorWarnings(provider.id); track warning) {
            <p class="warning-banner">{{ warning }}</p>
          }

          <ol class="accounts">
            @for (account of accountsFor(provider.id); track account.id; let index = $index; let first = $first; let last = $last; let count = $count) {
              <li class="account-card" [class.is-disabled]="!account.enabled">
                <div class="account-row">
                  @if (count > 1) {
                    <span class="order" [attr.aria-label]="'Position ' + (index + 1)">{{ index + 1 }}</span>
                  }
                  <div class="account-summary">
                    <div class="account-title">
                      <strong>{{ account.label }}</strong>
                      @if (account.id === defaultAccountId(provider.id)) {
                        <span class="chip default">Default</span>
                      }
                      @if (account.isLegacy) {
                        <span class="chip legacy">Existing sign-in</span>
                      }
                      @if (account.planLabel) {
                        <span class="chip plan">{{ account.planLabel }}</span>
                      }
                    </div>
                    <span class="status" [attr.data-state]="account.binding?.state ?? 'unavailable'">
                      {{ bindingLabel(account) }}
                      @if (account.expectedIdentity && account.binding?.state !== 'authenticated' && account.binding?.state !== 'identity-mismatch') {
                        · {{ account.expectedIdentity }}
                      }
                    </span>
                  </div>
                  <label class="toggle" [attr.title]="isOnlyEnabled(account) ? 'At least one account must stay enabled' : null">
                    <input
                      type="checkbox"
                      [checked]="account.enabled"
                      (change)="setEnabled(account, $any($event.target).checked)"
                      [disabled]="busy() || isOnlyEnabled(account)"
                    />
                    Enabled
                  </label>
                </div>

                @if (account.binding?.state === 'identity-mismatch' && account.binding?.observedIdentity) {
                  <p class="mismatch">
                    Signed in as {{ account.binding?.observedIdentity }}, not {{ account.expectedIdentity }}.
                    <button type="button" class="btn btn-secondary" (click)="adoptObserved(account)" [disabled]="busy()">
                      Use this account instead
                    </button>
                  </p>
                }

                <div class="account-controls">
                  <label class="inline-field">
                    Automatic use
                    <select
                      [ngModel]="account.automationPolicy"
                      (ngModelChange)="setAutomationPolicy(account, $event)"
                      [disabled]="busy()"
                      [attr.aria-label]="'Automatic use for ' + account.label"
                    >
                      <option value="allow-routed">Allowed</option>
                      <option value="manual-only">Only when I pick it</option>
                      <option value="disabled">Never</option>
                    </select>
                  </label>

                  <div class="account-actions">
                    @if (isSignedIn(account)) {
                      <button type="button" class="btn btn-secondary" (click)="verify(account)" [disabled]="busy()">Check sign-in</button>
                      <button type="button" class="btn btn-secondary" (click)="signIn(account)" [disabled]="busy()"
                        title="Copies a sign-in command to paste in your terminal">Sign in again</button>
                    } @else {
                      <button type="button" class="btn btn-primary" (click)="signIn(account)" [disabled]="busy()">Copy sign-in command</button>
                      <button type="button" class="btn btn-secondary" (click)="signIn(account, true)" [disabled]="busy()">Open a terminal</button>
                      <button type="button" class="btn btn-secondary" (click)="verify(account)" [disabled]="busy()">Check sign-in</button>
                    }
                    <span class="action-divider" aria-hidden="true"></span>
                    @if (count > 1) {
                      <button type="button" class="btn btn-secondary icon" (click)="move(account, -1)" [disabled]="busy() || first"
                        [attr.aria-label]="'Move ' + account.label + ' up'" title="Move up">↑</button>
                      <button type="button" class="btn btn-secondary icon" (click)="move(account, 1)" [disabled]="busy() || last"
                        [attr.aria-label]="'Move ' + account.label + ' down'" title="Move down">↓</button>
                    }
                    <button type="button" class="btn btn-secondary" (click)="rename(account)" [disabled]="busy()">Rename</button>
                    @if (!account.isLegacy) {
                      <button type="button" class="btn btn-danger" (click)="remove(account)" [disabled]="busy()">Remove</button>
                    }
                  </div>
                </div>
              </li>
            }
          </ol>

          <div class="add-account">
            <div class="add-row">
              <input
                type="text"
                [ngModel]="newLabels()[provider.id]"
                (ngModelChange)="setNewLabel(provider.id, $event)"
                (keydown.enter)="addAccount(provider.id)"
                [placeholder]="provider.subscription + ' account name, e.g. Work'"
                [attr.aria-label]="'New ' + provider.label + ' account name'"
                maxlength="64"
              />
              <button
                type="button"
                class="btn btn-secondary"
                (click)="addAccount(provider.id)"
                [disabled]="busy() || !(newLabels()[provider.id] ?? '').trim()"
              >
                Add account
              </button>
            </div>
            <p class="hint">Adding an account copies a sign-in command for you to paste in your own terminal.</p>
          </div>

          @if (pools()?.[provider.id]; as policy) {
            @if (accountsFor(provider.id).length < 2) {
              <p class="hint">Add a second {{ provider.subscription }} account to choose what happens when one hits its limit.</p>
            } @else {
              <div class="pool-policy">
                <h5 class="policy-title">When an account hits its limit</h5>

                @if (policy.acknowledgedOwnershipAt === null) {
                  <div class="ownership">
                    <p>
                      Before a second {{ provider.label }} account can be enabled, confirm that every account in
                      this list is a {{ provider.subscription }} subscription you personally pay for, and that you
                      understand {{ provider.id === 'claude' ? 'Anthropic' : 'OpenAI' }} may still apply its own
                      usage policies to how the accounts are used.
                    </p>
                    <button type="button" class="btn btn-primary" (click)="acknowledge(provider.id)" [disabled]="busy()">
                      I confirm these are my own accounts
                    </button>
                  </div>
                }

                <div class="policy-grid">
                  <label class="field">
                    Switching
                    <select [ngModel]="policy.failoverMode" (ngModelChange)="updatePool(provider.id, { failoverMode: $event })" [disabled]="busy()">
                      <option value="automatic">Move to the next account automatically</option>
                      <option value="ask">Tell me and let me switch</option>
                      <option value="off">Wait for the limit to reset</option>
                    </select>
                  </label>
                  <label class="field">
                    Conversation after a switch
                    <select [ngModel]="policy.continuation" (ngModelChange)="updatePool(provider.id, { continuation: $event })" [disabled]="busy()">
                      <option value="shared-store">Resume the same session (shared history)</option>
                      <option value="replay">Start a fresh session with the transcript</option>
                    </select>
                  </label>
                </div>

                <fieldset class="early-switch">
                  <legend>Switch before the limit</legend>
                  <label class="sentence">
                    Treat an account as nearly used up at
                    <input
                      type="number"
                      class="narrow"
                      min="1"
                      max="100"
                      [ngModel]="policy.preemptive.thresholdPct"
                      (change)="updatePool(provider.id, { preemptive: { thresholdPct: clampPct($any($event.target).value) } })"
                      [disabled]="busy()"
                    />
                    % of its 5-hour usage
                  </label>
                  <label class="toggle">
                    <input
                      type="checkbox"
                      [checked]="policy.preemptive.newSessions"
                      (change)="updatePool(provider.id, { preemptive: { newSessions: $any($event.target).checked } })"
                      [disabled]="busy()"
                    />
                    Start new sessions on another account
                  </label>
                  <label class="toggle">
                    <input
                      type="checkbox"
                      [checked]="policy.preemptive.liveSessionsAtTurnBoundary"
                      (change)="updatePool(provider.id, { preemptive: { liveSessionsAtTurnBoundary: $any($event.target).checked } })"
                      [disabled]="busy()"
                    />
                    Also move running sessions between turns
                  </label>
                  @if (policy.preemptive.liveSessionsAtTurnBoundary && policy.failoverMode !== 'automatic') {
                    <p class="hint indented">Running sessions only move when switching is set to automatic.</p>
                  }
                  <label class="sentence">
                    Wait at least
                    <input
                      type="number"
                      class="narrow"
                      min="0"
                      max="1440"
                      [ngModel]="cooldownMinutes(policy)"
                      (change)="updatePool(provider.id, { switchCooldownMs: minutesToMs($any($event.target).value) })"
                      [disabled]="busy()"
                    />
                    minutes before switching the same session again
                  </label>
                </fieldset>
              </div>
            }
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .provider-accounts-tab { display: flex; flex-direction: column; gap: 24px; }
    .tab-intro { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    .section-desc { color: var(--text-secondary); margin: 0; max-width: 68ch; }
    .error-banner, .warning-banner, .notice-banner {
      margin: 0; padding: 8px 12px; border-radius: 6px;
      border: 1px solid var(--border-color); background: var(--bg-secondary);
    }
    .error-banner { border-color: var(--error-color, #d33); }
    .hint { margin: 0; font-size: 12px; color: var(--text-muted, var(--text-secondary)); }
    .hint.indented { padding-left: 24px; }
    .provider-section {
      display: flex; flex-direction: column; gap: 12px;
      padding: 16px; border: 1px solid var(--border-color); border-radius: 10px;
    }
    .provider-title { margin: 0; font-size: 15px; }
    .accounts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .account-card {
      border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 14px;
      display: flex; flex-direction: column; gap: 10px; background: var(--bg-secondary);
    }
    .account-card.is-disabled .account-summary { opacity: 0.6; }
    .account-row { display: flex; align-items: center; gap: 12px; }
    .order {
      flex: none; width: 24px; height: 24px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; border: 1px solid var(--border-color); color: var(--text-secondary);
    }
    .account-summary { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .account-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .chip { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border-color); color: var(--text-secondary); }
    .status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
    .status::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted, #888); }
    .status[data-state='authenticated']::before { background: var(--success-color, #4a9); }
    .status[data-state='unauthenticated']::before { background: var(--warning-color, #d93); }
    .status[data-state='identity-mismatch']::before { background: var(--error-color, #d33); }
    .mismatch { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .account-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
    .inline-field { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
    .account-actions, .add-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .account-actions .btn { padding: 4px 10px; }
    .account-actions .btn.icon { min-width: 30px; padding: 4px 6px; }
    .action-divider { width: 1px; align-self: stretch; margin: 0 4px; background: var(--border-color); }
    .add-account { display: flex; flex-direction: column; gap: 4px; }
    .add-row input { flex: 1 1 18rem; min-width: 0; max-width: 28rem; }
    .toggle { display: inline-flex; align-items: center; gap: 8px; }
    .pool-policy { border-top: 1px solid var(--border-color); padding-top: 12px; display: flex; flex-direction: column; gap: 12px; }
    .policy-title { margin: 0; font-size: 13px; }
    .ownership { padding: 12px; border-radius: 6px; border: 1px solid var(--warning-border, var(--border-color)); background: var(--warning-bg, var(--bg-secondary)); }
    .ownership p { margin: 0 0 10px; }
    .policy-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); }
    .early-switch { margin: 0; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 6px; display: flex; flex-direction: column; gap: 8px; }
    .early-switch legend { padding: 0 4px; font-size: 12px; color: var(--text-secondary); }
    .sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    input.narrow { width: 5rem; }
  `],
})
export class ProviderAccountsTabComponent implements OnInit {
  private readonly ipc = inject(ProviderAccountIpcService);
  private readonly destroyRef = inject(DestroyRef);

  readonly providers = PROVIDERS;

  private readonly accountsSignal = signal<ProviderAccountView[]>([]);
  private readonly poolsSignal = signal<ProviderAccountPools | null>(null);
  private readonly doctorSignal = signal<Partial<Record<PooledProvider, ProviderAccountDoctorView | null>>>({});
  private readonly busySignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  private readonly noticeSignal = signal<string | null>(null);
  private readonly newLabelsSignal = signal<Partial<Record<PooledProvider, string>>>({});
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly accounts = this.accountsSignal.asReadonly();
  readonly pools = this.poolsSignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();
  readonly notice = this.noticeSignal.asReadonly();
  readonly newLabels = this.newLabelsSignal.asReadonly();
  private readonly byProvider = computed(() => {
    const grouped: Record<PooledProvider, ProviderAccountView[]> = { claude: [], codex: [] };
    for (const account of this.accountsSignal()) grouped[account.provider].push(account);
    for (const list of Object.values(grouped)) list.sort((a, b) => a.priority - b.priority);
    return grouped;
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  ngOnInit(): void {
    void this.refresh();
  }

  accountsFor(provider: PooledProvider): ProviderAccountView[] {
    return this.byProvider()[provider];
  }

  /** The configured default: the first enabled account in priority order. Routing still skips it while it is signed out or at its limit. */
  defaultAccountId(provider: PooledProvider): string | null {
    return this.byProvider()[provider].find((account) => account.enabled)?.id ?? null;
  }

  isSignedIn(account: ProviderAccountView): boolean {
    return account.binding?.state === 'authenticated';
  }

  /** The store refuses to disable the last enabled account, so the toggle does too. */
  isOnlyEnabled(account: ProviderAccountView): boolean {
    return account.enabled
      && this.byProvider()[account.provider].filter((entry) => entry.enabled).length === 1;
  }

  doctorWarnings(provider: PooledProvider): string[] {
    return this.doctorSignal()[provider]?.warnings ?? [];
  }

  setNewLabel(provider: PooledProvider, value: string): void {
    this.newLabelsSignal.update((labels) => ({ ...labels, [provider]: value }));
  }

  bindingLabel(account: ProviderAccountView): string {
    switch (account.binding?.state) {
      case 'authenticated':
        return `Signed in${account.binding.observedIdentity ? ` as ${account.binding.observedIdentity}` : ''}`;
      case 'identity-mismatch':
        return 'Different account signed in';
      case 'unavailable':
        return 'Could not check';
      default:
        return 'Not signed in';
    }
  }

  cooldownMinutes(policy: ProviderAccountPoolPolicy): number {
    return Math.round(policy.switchCooldownMs / 60_000);
  }

  minutesToMs(value: string | number): number {
    const minutes = Math.max(0, Math.min(1440, Math.round(Number(value) || 0)));
    return minutes * 60_000;
  }

  clampPct(value: string | number): number {
    return Math.max(1, Math.min(100, Math.round(Number(value) || 90)));
  }

  async refresh(): Promise<void> {
    await this.run(() => this.load());
  }

  async addAccount(provider: PooledProvider): Promise<void> {
    const label = (this.newLabelsSignal()[provider] ?? '').trim();
    // Enter in the name field bypasses the disabled button, so re-check here.
    if (!label || this.busySignal()) return;
    await this.run(async () => {
      const created = await this.ipc.create({ provider, label });
      if (!created.success) throw new Error(created.error?.message ?? 'The account could not be added.');
      this.setNewLabel(provider, '');
      const profile = created.data as ProviderAccountView;
      await this.launchSignIn(profile);
      await this.load();
    });
  }

  async signIn(account: ProviderAccountView, openTerminal = false): Promise<void> {
    await this.run(() => this.launchSignIn(account, openTerminal));
  }

  async verify(account: ProviderAccountView): Promise<void> {
    await this.mutate(() => this.ipc.verify(account.provider, account.id));
  }

  async adoptObserved(account: ProviderAccountView): Promise<void> {
    await this.mutate(() => this.ipc.update({ provider: account.provider, profileId: account.id, adoptObservedIdentity: true }));
  }

  async setEnabled(account: ProviderAccountView, enabled: boolean): Promise<void> {
    if (enabled === account.enabled) return;
    await this.mutate(() => this.ipc.update({ provider: account.provider, profileId: account.id, enabled }));
  }

  async setAutomationPolicy(account: ProviderAccountView, automationPolicy: AccountAutomationPolicy): Promise<void> {
    if (automationPolicy === account.automationPolicy) return;
    await this.mutate(() => this.ipc.update({ provider: account.provider, profileId: account.id, automationPolicy }));
  }

  async rename(account: ProviderAccountView): Promise<void> {
    const label = globalThis.prompt?.('New name for this account', account.label)?.trim();
    if (!label || label === account.label) return;
    await this.mutate(() => this.ipc.update({ provider: account.provider, profileId: account.id, label }));
  }

  async move(account: ProviderAccountView, delta: -1 | 1): Promise<void> {
    const ordered = this.accountsFor(account.provider).map((entry) => entry.id);
    const index = ordered.indexOf(account.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
    await this.mutate(() => this.ipc.setPriorityOrder(account.provider, ordered));
  }

  async remove(account: ProviderAccountView): Promise<void> {
    const confirmed = globalThis.confirm?.(
      `Remove "${account.label}"? Conversations that last ran on it will continue on another account. `
      + 'This does not sign the account out or cancel the subscription.',
    );
    if (!confirmed) return;
    await this.mutate(() => this.ipc.remove(account.provider, account.id));
  }

  async acknowledge(provider: PooledProvider): Promise<void> {
    await this.mutate(() => this.ipc.acknowledgeOwnership(provider));
  }

  async updatePool(
    provider: PooledProvider,
    patch: {
      failoverMode?: AccountFailoverMode;
      continuation?: AccountContinuationMode;
      preemptive?: Partial<ProviderAccountPoolPolicy['preemptive']>;
      switchCooldownMs?: number;
    },
  ): Promise<void> {
    await this.mutate(() => this.ipc.updatePool({ provider, ...patch }));
  }

  private async launchSignIn(account: ProviderAccountView, openTerminal = false): Promise<void> {
    const response = await this.ipc.launchLogin(account.provider, account.id, openTerminal ? { openTerminal: true } : undefined);
    if (!response.success) {
      throw new Error(response.error?.message ?? (openTerminal
        ? 'The sign-in terminal could not be opened.'
        : 'The sign-in command could not be copied.'));
    }
    const hint = (response.data as { hint?: string } | undefined)?.hint;
    this.noticeSignal.set(openTerminal
      ? `Opened a terminal for "${account.label}". You can also paste the copied command in your own terminal.${hint ? ` ${hint}` : ''}`
      : `Sign-in command copied for "${account.label}". Paste it in your own terminal, finish login, then this page will update.${hint ? ` ${hint}` : ''}`);
    this.pollUntilSignedIn(account);
  }

  /** After a sign-in launch, re-verify until the account reports signed in (or give up quietly). */
  private pollUntilSignedIn(account: ProviderAccountView): void {
    this.stopPolling();
    let attempts = 0;
    this.pollTimer = setInterval(() => {
      attempts += 1;
      if (attempts > SIGN_IN_POLL_LIMIT) {
        this.stopPolling();
        return;
      }
      void this.checkSignIn(account);
    }, SIGN_IN_POLL_MS);
  }

  /** One poll tick. Never rejects: a failed check is simply retried on the next tick. */
  private async checkSignIn(account: ProviderAccountView): Promise<void> {
    try {
      const response = await this.ipc.verify(account.provider, account.id);
      const state = (response.data as ProviderAccountView | undefined)?.binding?.state;
      if (response.success && state === 'authenticated') {
        this.stopPolling();
        this.noticeSignal.set(`"${account.label}" is signed in.`);
        await this.load();
      }
    } catch {
      // Retried on the next tick, up to the attempt limit.
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async load(): Promise<void> {
    const { profiles, pools } = await this.ipc.list();
    this.accountsSignal.set(profiles);
    this.poolsSignal.set(pools);
    const doctors = await Promise.all(PROVIDERS.map(async (provider) => [provider.id, await this.ipc.doctor(provider.id)] as const));
    this.doctorSignal.set(Object.fromEntries(doctors));
  }

  private async mutate(action: () => Promise<{ success: boolean; error?: { message?: string } }>): Promise<void> {
    await this.run(async () => {
      const response = await action();
      if (!response.success) throw new Error(response.error?.message ?? 'That change could not be applied.');
      await this.load();
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
