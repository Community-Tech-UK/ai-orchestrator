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
      <div class="tab-header">
        <div>
          <h3 class="section-title">Claude &amp; Codex accounts</h3>
          <p class="section-desc">
            Add the Claude and ChatGPT subscriptions you pay for. Sessions use the first
            available account in the order below, and when one hits its usage limit the
            conversation can carry on under the next one. Adding an account copies a sign-in
            command to paste in your own terminal. Only you can change these; agents cannot.
          </p>
        </div>
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

          <div class="accounts">
            @for (account of accountsFor(provider.id); track account.id; let first = $first; let last = $last) {
              <article class="account-card" [class.is-disabled]="!account.enabled">
                <header>
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
                  <span class="chip binding" [attr.data-state]="account.binding?.state ?? 'unavailable'">
                    {{ bindingLabel(account) }}
                  </span>
                </header>

                <dl class="account-facts">
                  <div>
                    <dt>Account</dt>
                    <dd>{{ account.expectedIdentity ?? 'Not verified yet' }}</dd>
                  </div>
                  <div>
                    <dt>Order</dt>
                    <dd>{{ account.priority + 1 }}</dd>
                  </div>
                  <div>
                    <dt>Automatic work</dt>
                    <dd>
                      <select
                        [ngModel]="account.automationPolicy"
                        (ngModelChange)="setAutomationPolicy(account, $event)"
                        [disabled]="busy()"
                        [attr.aria-label]="'Automatic work for ' + account.label"
                      >
                        <option value="allow-routed">Allowed</option>
                        <option value="manual-only">Only when I pick it</option>
                        <option value="disabled">Never</option>
                      </select>
                    </dd>
                  </div>
                </dl>

                @if (account.binding?.state === 'identity-mismatch' && account.binding?.observedIdentity) {
                  <p class="mismatch">
                    Signed in as {{ account.binding?.observedIdentity }}, not {{ account.expectedIdentity }}.
                    <button type="button" class="btn btn-link" (click)="adoptObserved(account)" [disabled]="busy()">
                      Use this account instead
                    </button>
                  </p>
                }

                <div class="account-actions">
                  <label class="toggle">
                    <input
                      type="checkbox"
                      [checked]="account.enabled"
                      (change)="setEnabled(account, $any($event.target).checked)"
                      [disabled]="busy()"
                    />
                    Enabled
                  </label>
                  <button type="button" class="btn" (click)="signIn(account)" [disabled]="busy()">Copy sign-in command</button>
                  <button type="button" class="btn btn-secondary" (click)="signIn(account, true)" [disabled]="busy()">Open a terminal</button>
                  <button type="button" class="btn btn-secondary" (click)="verify(account)" [disabled]="busy()">Verify</button>
                  <button type="button" class="btn btn-secondary" (click)="move(account, -1)" [disabled]="busy() || first"
                    [attr.aria-label]="'Move ' + account.label + ' up'">↑</button>
                  <button type="button" class="btn btn-secondary" (click)="move(account, 1)" [disabled]="busy() || last"
                    [attr.aria-label]="'Move ' + account.label + ' down'">↓</button>
                  <button type="button" class="btn btn-secondary" (click)="rename(account)" [disabled]="busy()">Rename</button>
                  @if (!account.isLegacy) {
                    <button type="button" class="btn btn-danger" (click)="remove(account)" [disabled]="busy()">Remove</button>
                  }
                </div>
              </article>
            }
          </div>

          <div class="add-row">
            <input
              type="text"
              [ngModel]="newLabels()[provider.id]"
              (ngModelChange)="setNewLabel(provider.id, $event)"
              [placeholder]="provider.subscription + ' account name, e.g. Max B'"
              [attr.aria-label]="'New ' + provider.label + ' account name'"
              maxlength="64"
            />
            <button
              type="button"
              class="btn"
              (click)="addAccount(provider.id)"
              [disabled]="busy() || !(newLabels()[provider.id] ?? '').trim()"
            >
              Add account
            </button>
          </div>

          @if (pools()?.[provider.id]; as policy) {
            <div class="pool-policy">
              @if (policy.acknowledgedOwnershipAt === null) {
                <div class="ownership">
                  <p>
                    Before a second {{ provider.label }} account can be enabled, confirm that every account in
                    this pool is a {{ provider.subscription }} subscription you personally pay for, and that you
                    understand {{ provider.id === 'claude' ? 'Anthropic' : 'OpenAI' }} may still apply its own
                    usage policies to how the accounts are used.
                  </p>
                  <button type="button" class="btn" (click)="acknowledge(provider.id)" [disabled]="busy()">
                    I confirm these are my own accounts
                  </button>
                </div>
              }

              <div class="policy-grid">
                <label>
                  When an account hits its limit
                  <select [ngModel]="policy.failoverMode" (ngModelChange)="updatePool(provider.id, { failoverMode: $event })" [disabled]="busy()">
                    <option value="automatic">Move to the next account automatically</option>
                    <option value="ask">Tell me and let me switch</option>
                    <option value="off">Wait for the limit to reset</option>
                  </select>
                </label>
                <label>
                  How the conversation continues
                  <select [ngModel]="policy.continuation" (ngModelChange)="updatePool(provider.id, { continuation: $event })" [disabled]="busy()">
                    <option value="shared-store">Resume the same session (shared history)</option>
                    <option value="replay">Start a fresh session with the transcript</option>
                  </select>
                </label>
                <label class="toggle">
                  <input
                    type="checkbox"
                    [checked]="policy.preemptive.newSessions"
                    (change)="updatePool(provider.id, { preemptive: { newSessions: $any($event.target).checked } })"
                    [disabled]="busy()"
                  />
                  Start new sessions on another account when one is nearly used up
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
                <label>
                  "Nearly used up" means 5-hour usage at or above (%)
                  <input
                    type="number"
                    min="1"
                    max="100"
                    [ngModel]="policy.preemptive.thresholdPct"
                    (change)="updatePool(provider.id, { preemptive: { thresholdPct: clampPct($any($event.target).value) } })"
                    [disabled]="busy()"
                  />
                </label>
                <label>
                  Minutes between switches for one session
                  <input
                    type="number"
                    min="0"
                    max="1440"
                    [ngModel]="cooldownMinutes(policy)"
                    (change)="updatePool(provider.id, { switchCooldownMs: minutesToMs($any($event.target).value) })"
                    [disabled]="busy()"
                  />
                </label>
              </div>
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .provider-accounts-tab { display: flex; flex-direction: column; gap: 20px; }
    .tab-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .section-desc { color: var(--text-secondary); margin: 4px 0 0; max-width: 68ch; }
    .error-banner, .warning-banner, .notice-banner {
      margin: 0; padding: 8px 12px; border-radius: 6px;
      border: 1px solid var(--border-color); background: var(--bg-secondary);
    }
    .error-banner { border-color: var(--error-color, #d33); }
    .provider-section { display: flex; flex-direction: column; gap: 12px; }
    .provider-title { margin: 0; font-size: 14px; }
    .accounts { display: flex; flex-direction: column; gap: 12px; }
    .account-card {
      border: 1px solid var(--border-color); border-radius: 8px; padding: 14px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .account-card.is-disabled { opacity: 0.7; }
    .account-card header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .account-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border-color); }
    .chip.binding[data-state='authenticated'] { border-color: var(--success-color, #4a9); }
    .chip.binding[data-state='identity-mismatch'] { border-color: var(--error-color, #d33); }
    .account-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin: 0; }
    .account-facts dt { font-size: 11px; color: var(--text-secondary); }
    .account-facts dd { margin: 2px 0 0; }
    .mismatch { margin: 0; }
    .account-actions, .add-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .toggle { display: inline-flex; align-items: center; gap: 6px; }
    .pool-policy { border-top: 1px solid var(--border-color); padding-top: 10px; display: flex; flex-direction: column; gap: 10px; }
    .ownership { padding: 10px 12px; border-radius: 6px; background: var(--bg-secondary); }
    .ownership p { margin: 0 0 8px; }
    .policy-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
    .policy-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
    .policy-grid label.toggle { flex-direction: row; }
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
    if (!label) return;
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
