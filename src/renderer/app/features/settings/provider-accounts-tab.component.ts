/**
 * Claude, Codex & MiMo Accounts settings section (provider account pools).
 *
 * Where James adds the Claude, ChatGPT and MiMo Token Plan subscriptions he
 * owns, orders them, and decides what happens when one hits its usage limit.
 * Each account signs in through a terminal against its own home (or, for MiMo,
 * its own key name in OpenCode's key store). MiMo usage has a separate saved
 * console session; credentials never cross into this renderer.
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
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { PromptModalComponent } from '../../shared/components/prompt-modal/prompt-modal.component';
import {
  ProviderAccountIpcService,
  type ProviderAccountDoctorView,
  type ProviderAccountView,
} from '../../core/services/ipc/provider-account-ipc.service';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import type { ProviderId } from '../../../../shared/types/provider-quota.types';
import type {
  AccountAutomationPolicy,
  AccountContinuationMode,
  AccountFailoverMode,
  OpenCodeAccountRegion,
  PooledProvider,
  ProviderAccountPoolPolicy,
  ProviderAccountPools,
} from '../../../../shared/types/provider-account.types';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { accountMachinesFor, nodeLoginCommandFor, type AccountMachineState } from './provider-accounts-machines';

const PROVIDERS: readonly { id: PooledProvider; label: string; subscription: string; vendor: string }[] = [
  { id: 'claude', label: 'Claude', subscription: 'Claude', vendor: 'Anthropic' },
  { id: 'codex', label: 'Codex', subscription: 'ChatGPT', vendor: 'OpenAI' },
  { id: 'opencode', label: 'MiMo', subscription: 'MiMo Token Plan', vendor: 'Xiaomi' },
];

/**
 * Providers that only ever sign in once, through their own CLI — no account
 * list, ordering or limit-switching here. They still need a sign-in button on
 * this page so a "Reauth needed" banner always lands somewhere that can fix it.
 */
const SIGN_IN_ONLY_PROVIDERS: readonly { id: ProviderId; label: string }[] = [
  { id: 'gemini', label: 'Gemini' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'grok', label: 'Grok' },
];

const SIGN_IN_POLL_MS = 5_000;
const SIGN_IN_POLL_LIMIT = 60;

@Component({
  standalone: true,
  selector: 'app-provider-accounts-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PromptModalComponent, AioTooltipDirective],
  templateUrl: './provider-accounts-tab.component.html',
  styles: [`
    :host { display: block; min-width: 0; }
    .provider-accounts-tab { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
    .tab-intro { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    .section-desc { color: var(--text-secondary); margin: 0; max-width: 68ch; }
    .error-banner, .warning-banner, .notice-banner {
      margin: 0; padding: 8px 12px; border-radius: 6px;
      border: 1px solid var(--border-color); background: var(--bg-secondary); overflow-wrap: anywhere;
    }
    .error-banner { border-color: var(--error-color, #d33); }
    .hint { margin: 0; font-size: 12px; color: var(--text-muted, var(--text-secondary)); }
    .hint.indented { padding-left: 24px; }
    .provider-section {
      display: flex; flex-direction: column; gap: 12px; min-width: 0;
      padding: 16px; border: 1px solid var(--border-color); border-radius: 10px;
    }
    .provider-title { margin: 0; font-size: 15px; }
    .accounts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .account-card {
      border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 14px;
      display: flex; flex-direction: column; gap: 10px; background: var(--bg-secondary); min-width: 0;
    }
    .account-card.is-disabled .account-summary { opacity: 0.6; }
    .account-row { display: flex; align-items: center; gap: 12px; }
    .order {
      flex: none; width: 24px; height: 24px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; border: 1px solid var(--border-color); color: var(--text-secondary);
    }
    .account-summary { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .account-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; overflow-wrap: anywhere; }
    .chip { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border-color); color: var(--text-secondary); }
    .status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
    .status::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted, #888); }
    .status[data-state='authenticated']::before { background: var(--success-color, #4a9); }
    .status[data-state='unauthenticated']::before { background: var(--warning-color, #d93); }
    .status[data-state='identity-mismatch']::before { background: var(--error-color, #d33); }
    .mismatch { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .machines { display: flex; flex-direction: column; gap: 4px; }
    .usage-access { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border-color); padding-top: 10px; }
    .usage-title { margin: 0; font-size: 12px; font-weight: 600; }
    .machines-title { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .machine-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
    .machine-command { display: flex; align-items: flex-start; gap: 8px; flex: 1 1 100%; min-width: 0; }
    .machine-command code { flex: 1; min-width: 0; max-height: 72px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 6px 8px; border: 1px solid var(--border-color); border-radius: 4px; }
    .machine-command .btn { flex: none; }
    .machine-state.ok { color: var(--success-color, #4a9); }
    .account-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
    .inline-field { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
    .account-actions, .add-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .account-actions .btn { padding: 4px 10px; }
    .account-actions .btn.icon { min-width: 30px; padding: 4px 6px; }
    .account-actions .btn.icon.aio-reason-disabled {
      opacity: 0.5; cursor: not-allowed;
      background: var(--bg-tertiary); color: var(--text-primary); border-color: var(--border-color);
    }
    .sign-in-rows { display: flex; flex-direction: column; gap: 8px; }
    .sign-in-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .action-divider { width: 1px; align-self: stretch; margin: 0 4px; background: var(--border-color); }
    .add-account { display: flex; flex-direction: column; gap: 4px; }
    .add-row input { flex: 1 1 18rem; min-width: 0; max-width: 28rem; }
    .toggle { display: inline-flex; align-items: center; gap: 8px; }
    .pool-policy { border-top: 1px solid var(--border-color); padding-top: 12px; display: flex; flex-direction: column; gap: 12px; }
    .policy-title { margin: 0; font-size: 13px; }
    .ownership { padding: 12px; border-radius: 6px; border: 1px solid var(--warning-border, var(--border-color)); background: var(--warning-bg, var(--bg-secondary)); }
    .ownership p { margin: 0 0 10px; }
    .policy-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); min-width: 0; }
    select { min-width: 0; max-width: 100%; }
    .early-switch { margin: 0; min-width: 0; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 6px; display: flex; flex-direction: column; gap: 8px; }
    .early-switch legend { padding: 0 4px; font-size: 12px; color: var(--text-secondary); }
    .sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    input.narrow { width: 5rem; }
  `],
})
export class ProviderAccountsTabComponent implements OnInit {
  private readonly ipc = inject(ProviderAccountIpcService);
  private readonly providerIpc = inject(ProviderIpcService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly nodeStore = inject(RemoteNodeStore);

  readonly providers = PROVIDERS;
  readonly signInOnlyProviders = SIGN_IN_ONLY_PROVIDERS;
  protected readonly copy = copyFor;

  private readonly accountsSignal = signal<ProviderAccountView[]>([]);
  private readonly poolsSignal = signal<ProviderAccountPools | null>(null);
  private readonly doctorSignal = signal<Partial<Record<PooledProvider, ProviderAccountDoctorView | null>>>({});
  private readonly busySignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  private readonly noticeSignal = signal<string | null>(null);
  private readonly feedbackAccountSignal = signal<string | null>(null);
  private readonly signingInProviderSignal = signal<ProviderId | null>(null);
  private readonly newLabelsSignal = signal<Partial<Record<PooledProvider, string>>>({});
  private readonly newRegionsSignal = signal<Partial<Record<PooledProvider, OpenCodeAccountRegion>>>({});
  private readonly newChromeProfilesSignal = signal<Partial<Record<PooledProvider, string>>>({});
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private actionGeneration = 0;

  readonly accounts = this.accountsSignal.asReadonly();
  readonly pools = this.poolsSignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();
  readonly notice = this.noticeSignal.asReadonly();
  readonly feedbackAccount = this.feedbackAccountSignal.asReadonly();
  readonly signingInProvider = this.signingInProviderSignal.asReadonly();
  readonly newLabels = this.newLabelsSignal.asReadonly();
  readonly newRegions = this.newRegionsSignal.asReadonly();
  readonly newChromeProfiles = this.newChromeProfilesSignal.asReadonly();
  readonly hasAccountFeedback = computed(() => this.accountsSignal().some(account => this.feedbackFor(account)));
  private readonly byProvider = computed(() => {
    const grouped: Record<PooledProvider, ProviderAccountView[]> = { claude: [], codex: [], opencode: [] };
    for (const account of this.accountsSignal()) grouped[account.provider].push(account);
    for (const list of Object.values(grouped)) list.sort((a, b) => a.priority - b.priority);
    return grouped;
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.actionGeneration += 1;
      this.stopPolling();
    });
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

  setNewRegion(provider: PooledProvider, value: OpenCodeAccountRegion): void {
    this.newRegionsSignal.update((regions) => ({ ...regions, [provider]: value }));
  }

  setNewChromeProfile(provider: PooledProvider, value: string): void {
    this.newChromeProfilesSignal.update((profiles) => ({ ...profiles, [provider]: value }));
  }

  /** Remote machines and whether each has this MiMo account's sign-in (names-only advertisement). */
  machinesFor(account: ProviderAccountView): AccountMachineState[] {
    return accountMachinesFor(account, this.nodeStore.connectedNodes());
  }

  nodeLoginCommand(account: ProviderAccountView): string {
    return nodeLoginCommandFor(account);
  }

  async copyNodeCommand(account: ProviderAccountView): Promise<void> {
    await this.run(async () => {
      try {
        await globalThis.navigator.clipboard.writeText(this.nodeLoginCommand(account));
        this.noticeSignal.set('Copied the sign-in command. Run it in a terminal on that machine.');
      } catch {
        this.noticeSignal.set('Could not copy. Select the command shown beside this button and copy it yourself.');
      }
    }, account);
  }

  feedbackFor(account: ProviderAccountView): boolean {
    return this.feedbackAccount() === `${account.provider}/${account.id}`;
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
      const chromeProfile = (this.newChromeProfilesSignal()[provider] ?? '').trim();
      const created = await this.ipc.create({
        provider,
        label,
        ...(provider === 'opencode'
          ? {
              region: this.newRegionsSignal()[provider] ?? 'ams',
              ...(chromeProfile ? { chromeProfile } : {}),
            }
          : {}),
      });
      if (!created.success) throw new Error(created.error?.message ?? 'The account could not be added.');
      this.setNewLabel(provider, '');
      const profile = created.data as ProviderAccountView;
      await this.launchSignIn(profile);
      await this.load();
    });
  }

  async signIn(account: ProviderAccountView, openTerminal = false): Promise<void> {
    await this.run(() => this.launchSignIn(account, openTerminal), account);
  }

  /**
   * Sign-in for a provider that has no account list here (Gemini, Antigravity,
   * Cursor, Grok). The login is interactive, so this only opens a terminal
   * already running the right command — the same launcher the Doctor page uses.
   */
  async signInProvider(provider: ProviderId): Promise<void> {
    if (this.busySignal()) return;
    await this.run(async () => {
      this.signingInProviderSignal.set(provider);
      try {
        const response = await this.providerIpc.runProviderLogin(provider);
        if (!response.success) {
          throw new Error(response.error?.message ?? 'The sign-in terminal could not be opened.');
        }
        const data = response.data as { command?: string; terminal?: string; hint?: string } | undefined;
        const message = `${data?.terminal ?? 'A terminal'} opened running \`${data?.command ?? ''}\`. `
          + `${data?.hint ?? ''} Finish signing in there, then click Refresh above to check the connection.`;
        this.noticeSignal.set(message.replace(/\s+/g, ' ').trim());
      } finally {
        this.signingInProviderSignal.set(null);
      }
    });
  }

  async manageUsageSession(account: ProviderAccountView, action: 'connect' | 'disconnect'): Promise<void> {
    if (account.provider !== 'opencode' || this.busySignal()) return;
    await this.run(async () => {
      this.noticeSignal.set(null);
      const response = await this.ipc.quotaSession(account.id, action);
      if (!response.success) throw new Error(response.error?.message ?? 'Usage access could not be changed.');
      this.noticeSignal.set(action === 'connect'
        ? `Opened a Xiaomi sign-in window for "${account.label}". Sign in to the same account as its Token Plan, close the window, then click Refresh here to check the connection.`
        : `Saved usage login removed for "${account.label}". Usage may still refresh through its Chrome profile.`);
      await this.load();
    }, account);
  }

  async verify(account: ProviderAccountView): Promise<void> {
    await this.mutate(() => this.ipc.verify(account.provider, account.id), account);
  }

  async adoptObserved(account: ProviderAccountView): Promise<void> {
    await this.mutate(() => this.ipc.update({ provider: account.provider, profileId: account.id, adoptObservedIdentity: true }), account);
  }

  async setEnabled(account: ProviderAccountView, enabled: boolean): Promise<void> {
    if (enabled === account.enabled) return;
    await this.mutate(() => this.ipc.update({ provider: account.provider, profileId: account.id, enabled }), account);
  }

  async setAutomationPolicy(account: ProviderAccountView, automationPolicy: AccountAutomationPolicy): Promise<void> {
    if (automationPolicy === account.automationPolicy) return;
    await this.mutate(() => this.ipc.update({ provider: account.provider, profileId: account.id, automationPolicy }), account);
  }

  renameModalOpen = signal(false);
  renameInitial = signal('');
  private renameTarget: ProviderAccountView | null = null;

  rename(account: ProviderAccountView): void {
    this.renameTarget = account;
    this.renameInitial.set(account.label);
    this.renameModalOpen.set(true);
  }

  async onRenameSubmitted(label: string): Promise<void> {
    this.renameModalOpen.set(false);
    const account = this.renameTarget;
    this.renameTarget = null;
    if (!account || !label || label === account.label) return;
    await this.mutate(() => this.ipc.update({ provider: account.provider, profileId: account.id, label }), account);
  }

  onRenameCancelled(): void {
    this.renameModalOpen.set(false);
    this.renameTarget = null;
  }

  async move(account: ProviderAccountView, delta: -1 | 1): Promise<void> {
    const ordered = this.accountsFor(account.provider).map((entry) => entry.id);
    const index = ordered.indexOf(account.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
    await this.mutate(() => this.ipc.setPriorityOrder(account.provider, ordered), account);
  }

  async remove(account: ProviderAccountView): Promise<void> {
    const confirmed = globalThis.confirm?.(
      `Remove "${account.label}"? Conversations that last ran on it will continue on another account. `
      + 'This does not sign the account out or cancel the subscription.',
    );
    if (!confirmed) return;
    await this.mutate(() => this.ipc.remove(account.provider, account.id), account);
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
    this.feedbackAccountSignal.set(`${account.provider}/${account.id}`);
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
    const generation = this.actionGeneration;
    let attempts = 0;
    this.pollTimer = setInterval(() => {
      attempts += 1;
      if (attempts > SIGN_IN_POLL_LIMIT) {
        this.stopPolling();
        return;
      }
      void this.checkSignIn(account, generation);
    }, SIGN_IN_POLL_MS);
  }

  /** One poll tick. Never rejects: a failed check is simply retried on the next tick. */
  private async checkSignIn(account: ProviderAccountView, generation = this.actionGeneration): Promise<void> {
    try {
      const response = await this.ipc.verify(account.provider, account.id);
      if (generation !== this.actionGeneration) return;
      const state = (response.data as ProviderAccountView | undefined)?.binding?.state;
      if (response.success && state === 'authenticated') {
        this.stopPolling();
        if (this.feedbackFor(account)) this.noticeSignal.set(`"${account.label}" is signed in.`);
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

  private async mutate(action: () => Promise<{ success: boolean; error?: { message?: string } }>, account?: ProviderAccountView): Promise<void> {
    await this.run(async () => {
      const response = await action();
      if (!response.success) throw new Error(response.error?.message ?? 'That change could not be applied.');
      await this.load();
    }, account);
  }

  private async run(work: () => Promise<void>, account?: ProviderAccountView): Promise<void> {
    if (this.busySignal()) return;
    // A previous coding check must not replace a later action's feedback or stop its poll.
    this.actionGeneration += 1;
    this.stopPolling();
    this.busySignal.set(true);
    this.errorSignal.set(null);
    this.noticeSignal.set(null);
    this.feedbackAccountSignal.set(account ? `${account.provider}/${account.id}` : null);
    try {
      await work();
    } catch (error) {
      this.errorSignal.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busySignal.set(false);
    }
  }
}
