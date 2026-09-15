/**
 * Which Claude or Codex account a session uses, and why (provider account pools).
 *
 * Two placements:
 *  - `draft`: before a session starts, shows the account the pool would pick
 *    ("Max A · default", "Max B · Max A is at its limit") with an override.
 *    The override is emitted so the create sends the account the user chose.
 *  - `session`: the account a live session runs on and how it got there, with
 *    a switch that asks for confirmation (an explicit account handoff).
 *
 * Renders nothing for other providers or while the provider has no pool, so
 * hosts embed it unconditionally.
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
import type { AccountRouteSource, PooledProvider } from '../../../../shared/types/provider-account.types';
import { isPooledProvider } from '../../../../shared/types/provider-account.types';

@Component({
  standalone: true,
  selector: 'app-provider-account-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (poolActive()) {
      <div class="provider-account-chip" [class.compact]="mode() === 'session'" [class.blocked]="blockedText()">
        <span class="dot" [class.blocked]="blockedText()" aria-hidden="true"></span>
        <span class="text" [title]="title()">{{ blockedText() ?? label() }}</span>
        <select
          class="override"
          [attr.aria-label]="mode() === 'session' ? 'Switch this session to another account' : 'Account for this session'"
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
      display: inline-flex; align-items: center; gap: 8px;
      padding: 3px 10px; border-radius: 999px; font-size: 12px;
      border: 1px solid var(--border-color); background: var(--bg-secondary); max-width: 100%;
    }
    .provider-account-chip.compact { padding: 1px 8px; font-size: 11px; }
    .provider-account-chip.blocked { border-color: var(--error-color, #d33); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success-color, #4a9); }
    .dot.blocked { background: var(--error-color, #d33); }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .override { font-size: 11px; background: transparent; border: 0; color: inherit; max-width: 22px; }
  `],
})
export class ProviderAccountChipComponent {
  private readonly ipc = inject(ProviderAccountIpcService);

  readonly provider = input<string | null>(null);
  readonly mode = input<'draft' | 'session'>('draft');
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
  private readonly previewSignal = signal<ProviderAccountRoutePreview | null>(null);
  private readonly errorSignal = signal<string | null>(null);
  /** Bumped per load so a slower, older response never overwrites a newer one. */
  private loadGeneration = 0;

  readonly pooled = computed<PooledProvider | null>(() => {
    const provider = this.provider();
    return isPooledProvider(provider) ? provider : null;
  });
  readonly poolActive = computed(() => this.accountsSignal().some((account) => !account.isLegacy));
  readonly selectableAccounts = computed(() =>
    this.accountsSignal().filter((account) => account.enabled).sort((a, b) => a.priority - b.priority));
  readonly selectedValue = computed(() =>
    this.mode() === 'session' ? this.currentProfileId() : (this.chosenProfileId() ?? ''));

  readonly currentProfileId = computed(() => this.accountProfileId() ?? 'legacy');

  readonly label = computed(() => {
    if (this.mode() === 'session') {
      return `${this.labelFor(this.currentProfileId())} · ${this.sourceLabel(this.accountRoutingSource() ?? 'persisted')}`;
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

  readonly title = computed(() =>
    this.mode() === 'session'
      ? 'The account this conversation runs on. Pick another to move it there.'
      : 'The account a new session will use. Harness moves to the next account if this one hits its limit.');

  constructor() {
    effect(() => {
      const provider = this.pooled();
      const override = this.mode() === 'draft' ? this.chosenProfileId() ?? '' : '';
      const model = this.model();
      const nodeId = this.executionNodeId();
      const mode = this.mode();
      if (!provider) {
        this.loadGeneration += 1;
        this.accountsSignal.set([]);
        this.previewSignal.set(null);
        return;
      }
      void this.load(provider, mode, override, model, nodeId);
    });
  }

  async onSelect(event: Event): Promise<void> {
    const target = event.target as HTMLSelectElement;
    const value = target.value;
    if (this.mode() === 'draft') {
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
    mode: 'draft' | 'session',
    override: string,
    model: string | null,
    nodeId: string | null,
  ): Promise<void> {
    const generation = ++this.loadGeneration;
    try {
      const { profiles } = await this.ipc.list(provider);
      if (generation !== this.loadGeneration) return;
      this.accountsSignal.set(profiles);
      this.errorSignal.set(null);
      if (mode === 'draft' && override && !profiles.some((profile) => profile.id === override)) {
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
