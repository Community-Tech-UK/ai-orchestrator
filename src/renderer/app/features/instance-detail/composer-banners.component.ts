/**
 * Composer banner cluster — session-state bars that gate the composer, so
 * they render directly above it:
 *
 * - Provider quota park (WS7 Phase B): resume-now / cancel / switch-provider /
 *   switch-account (same-provider account pool, e.g. move off a limited
 *   Codex account onto a sibling one that was just topped up).
 * - Hardened (Seatbelt) denial (WS13 slice 3): the allow-and-retry lever —
 *   grant one absolute path as a writable root and restart into the rebuilt
 *   jail. Never disables the sandbox.
 */
import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { ProviderAccountIpcService, type ProviderAccountView } from '../../core/services/ipc/provider-account-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import type { InstanceStatus } from '../../core/state/instance/instance.types';
import type { InstanceWaitReason } from '../../../../shared/types/instance.types';
import { isPooledProvider } from '../../../../shared/types/provider-account.types';
import { formatQuotaParkCountdown } from './input-panel-formatters';

@Component({
  selector: 'app-composer-banners',
  standalone: true,
  template: `
    <!-- Provider quota park: gates the composer, so it renders here rather than in the header -->
    @if (quotaParkLabel()) {
      <div class="quota-park-bar" role="status" [title]="quotaParkDetail()">
        <span class="quota-park-text">{{ quotaParkLabel() }}</span>
        <button
          type="button"
          class="quota-park-btn"
          title="Resume this session now instead of waiting"
          (click)="onResumeFromProviderLimit()"
        >Resume now</button>
        <button
          type="button"
          class="quota-park-btn quota-park-btn--secondary"
          title="Cancel the auto-resume for this session"
          (click)="onCancelProviderLimitPark()"
        >Cancel</button>
        @if (canOfferFailover()) {
          <button
            type="button"
            class="quota-park-btn"
            title="Move this conversation to the next configured fallback provider instead of waiting"
            (click)="onFailoverNow()"
          >Switch provider</button>
        }
        @if (accountSwitchOptions().length > 0) {
          <select
            class="quota-park-account-select"
            aria-label="Switch this session to another Claude or Codex account"
            title="Move this conversation to a different account for the same provider (e.g. one you just topped up)"
            [disabled]="accountSwitchBusy()"
            (change)="onSwitchAccount($event)"
          >
            <option value="" selected disabled>Switch account…</option>
            @for (account of accountSwitchOptions(); track account.id) {
              <option [value]="account.id">{{ account.label }}</option>
            }
          </select>
        }
      </div>
    }

    <!-- Provider signed us out mid-session: sign in, then resume the lost turn -->
    @if (authRequired(); as auth) {
      <div class="quota-park-bar auth-required-bar" role="status" [title]="authDetail()">
        <span class="quota-park-text">{{ authLabel() }}</span>
        <button
          type="button"
          class="quota-park-btn"
          title="Open a terminal running this provider's sign-in command"
          [disabled]="authBusy()"
          (click)="onSignIn(auth.provider)"
        >Sign in</button>
        <button
          type="button"
          class="quota-park-btn"
          title="Check again and resume the interrupted turn"
          [disabled]="authBusy()"
          (click)="onAuthRetry()"
        >{{ authBusy() ? 'Checking…' : 'Retry now' }}</button>
        <button
          type="button"
          class="quota-park-btn quota-park-btn--secondary"
          title="Dismiss this banner and stop watching for a sign-in"
          [disabled]="authBusy()"
          (click)="onAuthDismiss()"
        >Dismiss</button>
      </div>
    }
    @if (authNotice()) {
      <div class="quota-park-bar auth-required-bar" role="status">
        <span class="quota-park-text">{{ authNotice() }}</span>
      </div>
    }

    <!-- WS13: hardened session died — offer the allow-and-retry lever -->
    @if (showHardenedDenialBar()) {
      <div class="quota-park-bar hardened-denial-bar" role="status">
        <span class="quota-park-text">Hardened session exited — the sandbox may have blocked a write.</span>
        <input
          class="hardened-path-input"
          type="text"
          placeholder="/absolute/path/to/allow"
          [value]="hardenedAllowPathValue()"
          (input)="onHardenedPathInput($event)"
        />
        <button
          type="button"
          class="quota-park-btn"
          [disabled]="hardenedAllowBusy()"
          title="Grant this path as a writable root and restart the session inside the rebuilt sandbox"
          (click)="onHardenedAllowPath()"
        >Allow path & retry</button>
        <button
          type="button"
          class="quota-park-btn quota-park-btn--secondary"
          [disabled]="hardenedAllowBusy()"
          title="Restart the session in the same sandbox without granting anything new"
          (click)="onHardenedRetry()"
        >Just retry</button>
      </div>
    }
  `,
  styles: `
    .quota-park-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      margin-bottom: 8px;
      border-radius: 8px;
      background: var(--surface-sunken-bg, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
      font-size: 12px;
      color: var(--text-secondary);
      cursor: help;

      .quota-park-text {
        flex: 1;
      }

      .quota-park-btn {
        font-size: 11px;
        padding: 2px 10px;
        border-radius: 5px;
        border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;

        &:hover {
          background: var(--hover-bg, rgba(255, 255, 255, 0.06));
          color: var(--text-primary, #fff);
        }

        &.quota-park-btn--secondary {
          color: var(--text-muted);
        }
      }

      .quota-park-account-select {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 5px;
        border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
      }

      .hardened-path-input {
        flex: 1;
        min-width: 160px;
        font-size: 11px;
        font-family: var(--font-mono);
        padding: 3px 8px;
        border-radius: 5px;
        border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
        background: var(--surface-sunken-bg, rgba(255, 255, 255, 0.03));
        color: var(--text-primary, #fff);

        &::placeholder {
          color: var(--text-muted);
        }
      }
    }

    .auth-required-bar {
      cursor: default;

      .quota-park-text {
        flex: 1 1 auto;
      }
    }

    .hardened-denial-bar {
      cursor: default;

      .quota-park-text {
        flex: 0 1 auto;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerBannersComponent {
  private instanceIpc = inject(InstanceIpcService);
  private providerIpc = inject(ProviderIpcService);
  private providerAccountIpc = inject(ProviderAccountIpcService);
  private instanceStore = inject(InstanceStore);

  instanceId = input.required<string>();
  waitReason = input<InstanceWaitReason | undefined>(undefined);
  instanceStatus = input<InstanceStatus>('idle');

  /** Quota-park banner state (lives with the composer it gates). */
  readonly quotaPark = computed(() => {
    const wr = this.waitReason();
    return wr?.kind === 'quota-park' ? wr : null;
  });
  private readonly quotaParkNow = signal(Date.now());
  private readonly quotaParkTicker = effect((onCleanup) => {
    if (!this.quotaPark()) return;
    const timer = setInterval(() => this.quotaParkNow.set(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  readonly quotaParkLabel = computed(() => {
    const park = this.quotaPark();
    return park ? `Provider limit — ${formatQuotaParkCountdown(park.resumeAt, this.quotaParkNow())}` : null;
  });
  readonly quotaParkDetail = computed(() => {
    const park = this.quotaPark();
    if (!park) return '';
    return `Parked on a ${park.provider} limit. Re-checks the live quota every few minutes and resumes as soon as the limit lifts; resumes at ${new Date(park.resumeAt).toLocaleTimeString()} at the latest.`;
  });

  onResumeFromProviderLimit(): void {
    void this.instanceIpc.providerLimitResumeNow(this.instanceId());
  }

  onCancelProviderLimitPark(): void {
    void this.instanceIpc.providerLimitCancel(this.instanceId());
  }

  /**
   * Signed-out banner. Unlike the quota park there is no countdown — the main
   * process watches for the sign-in and resumes the interrupted turn itself;
   * these buttons are the manual path.
   */
  readonly authRequired = computed(() => {
    const wr = this.waitReason();
    return wr?.kind === 'auth-required' ? wr : null;
  });
  readonly authBusy = signal(false);
  readonly authNotice = signal<string | null>(null);

  readonly authLabel = computed(() => {
    const auth = this.authRequired();
    return auth ? `Signed out of ${auth.provider} — sign in to resume this session.` : null;
  });
  readonly authDetail = computed(() => {
    const auth = this.authRequired();
    if (!auth) return '';
    return `The ${auth.provider} credentials expired during this session. Sign in and the interrupted turn is re-sent automatically; "Retry now" checks immediately.`;
  });

  async onSignIn(provider: string): Promise<void> {
    this.authNotice.set(null);
    this.authBusy.set(true);
    try {
      const response = await this.providerIpc.runProviderLogin(provider);
      if (!response.success) {
        this.authNotice.set(response.error?.message ?? 'Could not open a sign-in terminal.');
        return;
      }
      const data = response.data as { command: string; terminal: string } | undefined;
      this.authNotice.set(
        data
          ? `${data.terminal} opened running \`${data.command}\`. This session resumes on its own once you finish.`
          : 'Sign-in terminal opened. This session resumes on its own once you finish.',
      );
    } finally {
      this.authBusy.set(false);
    }
  }

  async onAuthRetry(): Promise<void> {
    this.authNotice.set(null);
    this.authBusy.set(true);
    try {
      const response = await this.instanceIpc.authRepairRetry(this.instanceId());
      if (!response.success) {
        this.authNotice.set(response.error?.message ?? 'Could not check the sign-in status.');
        return;
      }
      const outcome = response.data as { status: string; message?: string } | undefined;
      switch (outcome?.status) {
        case 'resumed':
          // The banner disappears with the waitReason; no notice needed.
          break;
        case 'still-signed-out':
          this.authNotice.set('Still signed out — finish signing in, then try again.');
          break;
        case 'unknown':
          this.authNotice.set(outcome.message ?? 'Could not read the provider auth status.');
          break;
        default:
          // `not-blocked`: main has no auth-repair entry for this session, so
          // Retry cannot resume it — this is the Copilot routing park, which
          // sets the same waitReason without registering. Say so instead of
          // silently doing nothing, which read as a broken button.
          this.authNotice.set(
            'This hold cannot be retried here — send a message to restart the session.',
          );
      }
    } finally {
      this.authBusy.set(false);
    }
  }

  onAuthDismiss(): void {
    this.authNotice.set(null);
    void this.instanceIpc.authRepairCancel(this.instanceId());
  }

  /** WS7 Phase B — offer a provider switch while parked, when fallbacks exist. */
  readonly canOfferFailover = computed(() => {
    if (!this.quotaPark()) return false;
    const inst = this.instanceStore.getInstance(this.instanceId());
    return Boolean(inst?.failoverProviders?.some((p) => p !== inst.provider));
  });

  onFailoverNow(): void {
    void this.instanceIpc.instanceFailoverNow(this.instanceId());
  }

  /**
   * Same-provider account switch while parked, e.g. moving off a Codex
   * account that's still limited onto a sibling one that was just topped
   * up. This is the in-session-window equivalent of the account chip in the
   * header, surfaced right where the user is already looking for a way out.
   */
  private readonly accountsSignal = signal<ProviderAccountView[]>([]);
  private accountsLoadGeneration = 0;
  private readonly accountsLoader = effect(() => {
    const park = this.quotaPark();
    const provider = park?.provider;
    if (!provider || !isPooledProvider(provider)) {
      this.accountsLoadGeneration += 1;
      this.accountsSignal.set([]);
      return;
    }
    const generation = ++this.accountsLoadGeneration;
    void this.providerAccountIpc.list(provider).then(
      ({ profiles }) => {
        if (generation === this.accountsLoadGeneration) this.accountsSignal.set(profiles);
      },
      () => {
        if (generation === this.accountsLoadGeneration) this.accountsSignal.set([]);
      },
    );
  });

  readonly accountSwitchOptions = computed(() => {
    if (!this.quotaPark()) return [];
    const inst = this.instanceStore.getInstance(this.instanceId());
    const currentProfileId = inst?.accountProfileId ?? 'legacy';
    return this.accountsSignal().filter((account) => account.enabled && account.id !== currentProfileId);
  });

  readonly accountSwitchBusy = signal(false);

  async onSwitchAccount(event: Event): Promise<void> {
    const target = event.target as HTMLSelectElement;
    const profileId = target.value;
    target.value = '';
    if (!profileId || this.accountSwitchBusy()) return;
    this.accountSwitchBusy.set(true);
    try {
      const response = await this.providerAccountIpc.switchSession(this.instanceId(), profileId);
      if (!response.success) {
        this.instanceStore.setError(response.error?.message ?? 'The account could not be switched.');
      }
    } finally {
      this.accountSwitchBusy.set(false);
    }
  }

  /** WS13 slice 3 — hardened session died; offer the allow-and-retry lever. */
  readonly showHardenedDenialBar = computed(() => {
    if (this.instanceStatus() !== 'error') return false;
    return Boolean(this.instanceStore.getInstance(this.instanceId())?.hardened);
  });
  readonly hardenedAllowPathValue = signal('');
  readonly hardenedAllowBusy = signal(false);

  onHardenedPathInput(event: Event): void {
    this.hardenedAllowPathValue.set((event.target as HTMLInputElement).value);
  }

  async onHardenedAllowPath(): Promise<void> {
    const path = this.hardenedAllowPathValue().trim();
    if (!path || this.hardenedAllowBusy()) return;
    this.hardenedAllowBusy.set(true);
    try {
      const result = await this.instanceIpc.hardenedAllowPath(this.instanceId(), path);
      if (!result.success) {
        this.instanceStore.setError(result.error?.message || 'Failed to grant the path');
      } else {
        this.hardenedAllowPathValue.set('');
      }
    } finally {
      this.hardenedAllowBusy.set(false);
    }
  }

  /** Retry in the same jail without granting anything new. */
  onHardenedRetry(): void {
    void this.instanceIpc.restartInstance(this.instanceId());
  }
}
