/**
 * Which Claude or Codex account a session uses, and why (provider account pools).
 *
 * Three placements:
 *  - `draft`: before a session starts, shows the account the pool would pick
 *    ("Max A · default", "Max B · Max A is at its limit") with an override.
 *    The override is emitted so the create sends the account the user chose.
 *  - `session`: the account a live session runs on, with a switch that asks
 *    for confirmation (an explicit account handoff).
 *  - `continuation`: a history preview that has not started yet. The select
 *    emits the account to continue on; nothing is switched until restore.
 *
 * Renders nothing for other providers, or while fewer than two accounts can be
 * chosen. A second account that is off only because ownership is not confirmed
 * yet is still listed: picking it asks for that confirmation and turns it on.
 * Hosts embed the chip unconditionally.
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
  ProviderAccountIpcService,
  type ProviderAccountRoutePreview,
  type ProviderAccountView,
} from '../../core/services/ipc/provider-account-ipc.service';
import type {
  AccountRouteSource,
  PooledProvider,
  ProviderAccountPools,
} from '../../../../shared/types/provider-account.types';
import { isPooledProvider, pooledProviderLabel } from '../../../../shared/types/provider-account.types';
import { AioTooltipDirective } from '../tooltip/aio-tooltip.directive';

/** Same promise as Settings → Accounts. A second account stays off until the user confirms it. */
const OWNERSHIP_COPY: Record<PooledProvider, { subscription: string; vendor: string }> = {
  claude: { subscription: 'Claude', vendor: 'Anthropic' },
  codex: { subscription: 'ChatGPT', vendor: 'OpenAI' },
  opencode: { subscription: 'MiMo Token Plan', vendor: 'Xiaomi' },
};

@Component({
  standalone: true,
  selector: 'app-provider-account-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AioTooltipDirective],
  template: `
    @if (poolActive()) {
      <div class="provider-account-chip" [class.compact]="mode() === 'session'" [class.blocked]="blockedText()">
        <span class="dot" [class.blocked]="blockedText()" aria-hidden="true"></span>
        <span class="text">{{ blockedText() ?? label() }}</span>
        <select
          class="override"
          [attr.aria-label]="accountAriaLabel()"
          [appTooltip]="title()"
          [value]="selectedValue()"
          (change)="onSelect($event)"
        >
          @if (mode() === 'draft') {
            <option value="">Choose automatically</option>
          }
          @for (account of selectableAccounts(); track account.id) {
            <option [value]="account.id">{{ account.label }}</option>
          }
        </select>
      </div>
    }
  `,
  styles: [`
    .provider-account-chip {
      position: relative;
      display: inline-flex; align-items: center; gap: 8px;
      padding: 3px 10px; border-radius: 999px; font-size: 12px;
      border: 1px solid var(--border-color); background: var(--bg-secondary); max-width: 100%;
      cursor: pointer;
    }
    .provider-account-chip.compact { padding: 1px 8px; font-size: 11px; }
    .provider-account-chip.blocked { border-color: var(--error-color, #d33); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success-color, #4a9); }
    .dot.blocked { background: var(--error-color, #d33); }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Stretched over the whole chip (not just a sliver) so the whole lozenge is clickable. */
    .override {
      position: absolute; inset: 0; width: 100%; height: 100%;
      opacity: 0; border: 0; cursor: pointer; appearance: none;
    }
  `],
})
export class ProviderAccountChipComponent {
  private readonly ipc = inject(ProviderAccountIpcService);

  readonly provider = input<string | null>(null);
  readonly mode = input<'draft' | 'session' | 'continuation'>('draft');
  readonly model = input<string | null>(null);
  /** Draft placement: the worker node the session will run on (null = this machine). */
  readonly executionNodeId = input<string | null>(null);
  /** Session placement: the live instance and its stamped account. */
  readonly instanceId = input<string | null>(null);
  readonly accountProfileId = input<string | null | undefined>(null);
  readonly accountRoutingSource = input<AccountRouteSource | null | undefined>(null);

  /** Draft placement: the explicit choice held by the host (null = choose automatically). */
  readonly chosenProfileId = input<string | null>(null);
  /** Draft placement: the user picked an account (null = choose automatically). */
  readonly accountChosen = output<string | null>();

  private readonly accountsSignal = signal<ProviderAccountView[]>([]);
  private readonly poolsSignal = signal<ProviderAccountPools | null>(null);
  private readonly previewSignal = signal<ProviderAccountRoutePreview | null>(null);
  private readonly errorSignal = signal<string | null>(null);
  /** Bumped per load so a slower, older response never overwrites a newer one. */
  private loadGeneration = 0;

  readonly pooled = computed<PooledProvider | null>(() => {
    const provider = this.provider();
    return isPooledProvider(provider) ? provider : null;
  });
  /**
   * A second account is created off until the user confirms they pay for every
   * account in the pool. Until that confirmation, those accounts are still
   * choices: picking one asks for the confirmation and turns it on. After
   * confirmation, an account the user turned off stays out of the list.
   */
  readonly ownershipOpen = computed(() => {
    const provider = this.pooled();
    if (!provider) return false;
    return this.poolsSignal()?.[provider]?.acknowledgedOwnershipAt == null;
  });
  readonly selectableAccounts = computed(() => {
    const includeUnconfirmed = this.ownershipOpen();
    return this.accountsSignal()
      .filter((account) => account.automationPolicy !== 'disabled'
        && (account.enabled || includeUnconfirmed))
      .sort((a, b) => a.priority - b.priority);
  });
  readonly poolActive = computed(() => this.selectableAccounts().length > 1);
  readonly selectedValue = computed(() => {
    if (this.mode() === 'session') return this.currentProfileId();
    if (this.mode() === 'continuation') return this.chosenProfileId() || this.currentProfileId();
    return this.chosenProfileId() ?? '';
  });

  readonly currentProfileId = computed(() => this.accountProfileId() ?? 'legacy');

  readonly accountAriaLabel = computed(() => {
    if (this.mode() === 'session') return 'Switch this session to another account';
    if (this.mode() === 'continuation') return 'Account to continue this session on';
    return 'Account for this session';
  });

  readonly label = computed(() => {
    if (this.mode() === 'session') {
      return this.labelFor(this.currentProfileId());
    }
    if (this.mode() === 'continuation') {
      return this.labelFor(this.chosenProfileId() || this.currentProfileId());
    }
    const preview = this.previewSignal();
    if (!preview?.outcome.ok) return '';
    const route = preview.outcome.route;
    const skipped = preview.considered.find((entry) => entry.vetoReason === 'parked' || entry.vetoReason === 'exhausted');
    const reason = skipped && route.source === 'default'
      ? `${this.labelFor(skipped.profileId)} is at its limit`
      : this.sourceLabel(route.source);
    return `${route.profileLabel ?? this.labelFor(route.profileId)} · ${reason}`;
  });

  readonly blockedText = computed(() => {
    if (this.errorSignal()) return this.errorSignal();
    if (this.mode() !== 'draft') return null;
    const preview = this.previewSignal();
    return preview && !preview.outcome.ok ? preview.outcome.detail : null;
  });

  readonly title = computed(() => {
    if (this.mode() === 'session') {
      return 'The account this conversation runs on. Pick another to move it there.';
    }
    if (this.mode() === 'continuation') {
      return 'The account this conversation will continue on. Pick another to continue there.';
    }
    return 'The account a new session will use. Harness moves to the next account if this one hits its limit.';
  });

  constructor() {
    effect(() => {
      const provider = this.pooled();
      const override = this.mode() === 'session' ? '' : this.chosenProfileId() ?? '';
      const model = this.model();
      const nodeId = this.executionNodeId();
      const mode = this.mode();
      if (!provider) {
        this.loadGeneration += 1;
        this.accountsSignal.set([]);
        this.poolsSignal.set(null);
        this.previewSignal.set(null);
        return;
      }
      void this.load(provider, mode, override, model, nodeId);
    });
  }

  async onSelect(event: Event): Promise<void> {
    const target = event.target as HTMLSelectElement;
    const value = target.value;
    const chosen = this.accountsSignal().find((account) => account.id === value);
    if (chosen && !chosen.enabled) {
      const turnedOn = await this.turnOnForSelection(chosen);
      if (!turnedOn) {
        target.value = this.selectedValue();
        return;
      }
    }
    if (this.mode() === 'draft' || this.mode() === 'continuation') {
      this.accountChosen.emit(value || null);
      return;
    }
    const instanceId = this.instanceId();
    if (!instanceId || value === this.currentProfileId()) return;
    const confirmed = globalThis.confirm?.(
      `Move this conversation to "${this.labelFor(value)}"? The current session ends and the conversation continues on that account.`,
    );
    if (!confirmed) {
      target.value = this.currentProfileId();
      return;
    }
    const response = await this.ipc.switchSession(instanceId, value);
    this.errorSignal.set(response.success ? null : response.error?.message ?? 'The account could not be switched.');
    if (!response.success) target.value = this.currentProfileId();
  }

  /**
   * Picking an account that is off only because ownership is unconfirmed
   * records that confirmation, then turns the account on, before the session
   * uses it. Cancelling leaves the account off.
   */
  private async turnOnForSelection(account: ProviderAccountView): Promise<boolean> {
    const provider = this.pooled();
    if (!provider || !this.ownershipOpen()) return false;
    const copy = OWNERSHIP_COPY[provider];
    const confirmed = globalThis.confirm?.(
      `Before "${account.label}" can be used, confirm that every ${pooledProviderLabel(provider)} account is a ${copy.subscription} subscription you personally pay for, and that you understand ${copy.vendor} may still apply its own usage policies.`,
    );
    if (!confirmed) return false;
    const acknowledged = await this.ipc.acknowledgeOwnership(provider);
    if (!acknowledged.success) {
      this.errorSignal.set(acknowledged.error?.message ?? 'The accounts could not be confirmed.');
      return false;
    }
    const enabled = await this.ipc.update({ provider, profileId: account.id, enabled: true });
    if (!enabled.success) {
      this.errorSignal.set(enabled.error?.message ?? 'The account could not be turned on.');
      return false;
    }
    this.errorSignal.set(null);
    this.accountsSignal.update((accounts) => accounts.map((entry) => (
      entry.id === account.id ? { ...entry, enabled: true } : entry
    )));
    this.poolsSignal.update((pools) => {
      const policy = pools?.[provider];
      if (!pools || !policy) return pools;
      return {
        ...pools,
        [provider]: { ...policy, acknowledgedOwnershipAt: policy.acknowledgedOwnershipAt ?? Date.now() },
      };
    });
    return true;
  }

  private labelFor(profileId: string): string {
    return this.accountsSignal().find((account) => account.id === profileId)?.label ?? profileId;
  }

  private sourceLabel(source: AccountRouteSource): string {
    switch (source) {
      case 'explicit':
        return 'you chose this account';
      case 'failover':
        return 'moved here at a usage limit';
      case 'preemptive':
        return 'moved here before a usage limit';
      case 'persisted':
        return 'the account this conversation runs on';
      case 'legacy':
        return 'your existing sign-in';
      default:
        return 'default';
    }
  }

  private async load(
    provider: PooledProvider,
    mode: 'draft' | 'session' | 'continuation',
    override: string,
    model: string | null,
    nodeId: string | null,
  ): Promise<void> {
    const generation = ++this.loadGeneration;
    try {
      const { profiles, pools } = await this.ipc.list(provider);
      if (generation !== this.loadGeneration) return;
      this.accountsSignal.set(profiles);
      this.poolsSignal.set(pools);
      this.errorSignal.set(null);
      if (mode !== 'session' && override && !profiles.some((profile) => profile.id === override)) {
        // A choice made for another provider (or a removed account) must not ride along.
        this.accountChosen.emit(null);
        return;
      }
      if (mode === 'draft' && profiles.some((profile) => !profile.isLegacy)) {
        const preview = await this.ipc.previewRoute({
          provider,
          ...(model ? { model } : {}),
          ...(override ? { explicitProfileId: override } : {}),
          ...(nodeId ? { executionNodeId: nodeId } : {}),
        });
        if (generation === this.loadGeneration) this.previewSignal.set(preview);
      }
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.errorSignal.set(error instanceof Error ? error.message : 'Accounts could not be loaded.');
    }
  }
}
