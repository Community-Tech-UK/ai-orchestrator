import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild, untracked } from '@angular/core';
import { InstanceStore } from '../../../core/state/instance.store';
import { ProviderQuotaStore } from '../../../core/state/provider-quota.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { ProviderAccountIpcService } from '../../../core/services/ipc/provider-account-ipc.service';
import { CopilotAccountIpcService } from '../../../core/services/ipc/copilot-account-ipc.service';
import { describePostureSentence, postureFromInstance } from '../../../../../shared/session-posture';
import { isPooledProvider } from '../../../../../shared/types/provider-account.types';
import { sessionQuotaSnapshot } from '../session-quota-snapshot';
import { SessionStatusService } from './session-status.service';
import { buildSessionStatus } from './session-status.model';
import { SessionStatusCardComponent } from './session-status-card.component';

/** Mount once at the application root, so /status works on every page. */
@Component({ selector: 'app-session-status-host', standalone: true, imports: [SessionStatusCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<dialog #dialog tabindex="-1" aria-label="Session status" data-ui-hints-exempt="backdrop" (cancel)="status.close()" (click)="onBackdrop($event)" (keydown.escape)="status.close(); $event.stopPropagation()">
    @if (view(); as model) { <app-session-status-card [view]="model" (closed)="status.close()" /> }
  </dialog>`,
  styles: [`dialog { width:min(680px, calc(100vw - 32px)); max-height:calc(100vh - 32px); padding:0; border:0;
    background:transparent; overflow:auto; } dialog::backdrop { background:rgba(0,0,0,.45); }`],
})
export class SessionStatusHostComponent {
  readonly status = inject(SessionStatusService);
  private readonly instances = inject(InstanceStore);
  private readonly quotas = inject(ProviderQuotaStore);
  private readonly settings = inject(SettingsStore);
  private readonly accounts = inject(ProviderAccountIpcService);
  private readonly copilot = inject(CopilotAccountIpcService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly account = signal<{ label?: string; plan?: string }>({});
  private readonly openedAt = signal(Date.now());
  readonly view = computed(() => {
    const id = this.status.instanceId();
    const instance = id ? this.instances.getInstance(id) : null;
    if (!instance) return null;
    return buildSessionStatus({ instance, breakdown: this.status.breakdown(),
      quotaSnapshot: sessionQuotaSnapshot(instance, this.quotas.snapshots(), this.quotas.accountSnapshots()),
      accountLabel: this.account().label, accountPlan: this.account().plan,
      permissionSentence: describePostureSentence({ ...postureFromInstance(instance),
        computerUseEnabled: this.settings.settings().computerUseEnabled,
        computerUseMode: instance.computerUseMode ?? this.settings.settings().computerUseAutonomyLevel }),
      showCost: this.settings.showCost(), now: this.openedAt() });
  });
  constructor() {
    effect(() => {
      const element = this.dialog()?.nativeElement;
      if (!element) return;
      if (this.view() && !element.open) element.showModal();
      else if (!this.view() && element.open) element.close();
    });
    effect(onCleanup => {
      if (!this.status.instanceId()) return;
      this.openedAt.set(Date.now());
      // A local clock, never a provider poll. Keeps the cache sentence current.
      const timer = setInterval(() => this.openedAt.set(Date.now()), 60000);
      onCleanup(() => clearInterval(timer));
    });
    const accountKey = computed(() => {
      const id = this.status.instanceId(); const instance = id ? this.instances.getInstance(id) : null;
      return instance ? `${instance.id}:${instance.provider}:${instance.accountProfileId}:${instance.copilotAccountProfileId}` : '';
    });
    effect(onCleanup => {
      accountKey();
      const instance = untracked(() => { const id = this.status.instanceId(); return id ? this.instances.getInstance(id) : null; });
      this.account.set({});
      if (!instance) return;
      let current = true; onCleanup(() => { current = false; });
      if (instance.provider === 'copilot') {
        void this.copilot.list().then(accounts => {
          if (current) this.account.set({ label: accounts.find(a => a.id === (instance.copilotAccountProfileId ?? 'legacy'))?.label });
        }).catch(() => undefined);
      } else if (isPooledProvider(instance.provider)) {
        void this.accounts.list(instance.provider).then(({ profiles }) => {
          const account = profiles.find(a => a.id === (instance.accountProfileId ?? 'legacy'));
          if (current) this.account.set({ label: account?.label, plan: account?.planLabel ?? undefined });
        }).catch(() => undefined);
      }
    });
  }
  onBackdrop(event: MouseEvent): void { if (event.target === this.dialog()?.nativeElement) this.status.close(); }
}
