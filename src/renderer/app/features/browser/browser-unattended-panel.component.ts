import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import type { BrowserProfile } from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { BrowserUnattendedStore } from './browser-unattended.store';
import { BrowserVaultControlComponent } from './browser-vault-control.component';
import { BrowserCredentialAuthorizationPanelComponent } from './browser-credential-authorization-panel.component';
import { BrowserCampaignListComponent } from './browser-campaign-list.component';
import { BrowserEscalationQueueComponent } from './browser-escalation-queue.component';

const POLL_INTERVAL_MS = 10_000;

/**
 * Composition root for the unattended browser-automation layer: vault
 * control, standing credential authorizations, overnight campaigns, and the
 * escalation triage queue. Polls every ~10s while mounted since there is no
 * push channel for these entities yet.
 */
@Component({
  selector: 'app-browser-unattended-panel',
  standalone: true,
  imports: [
    BrowserVaultControlComponent,
    BrowserCredentialAuthorizationPanelComponent,
    BrowserCampaignListComponent,
    BrowserEscalationQueueComponent,
  ],
  templateUrl: './browser-unattended-panel.component.html',
  styleUrl: './browser-unattended-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserUnattendedPanelComponent implements OnInit, OnDestroy {
  private readonly gatewayIpc = inject(BrowserGatewayIpcService);
  private readonly store = inject(BrowserUnattendedStore);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly profiles = signal<BrowserProfile[]>([]);
  readonly loading = signal(false);

  async ngOnInit(): Promise<void> {
    await this.refreshNow();
    this.pollTimer = setInterval(() => {
      void this.store.refreshAll();
    }, POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async refreshNow(): Promise<void> {
    this.loading.set(true);
    try {
      await Promise.all([this.loadProfiles(), this.store.refreshAll()]);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadProfiles(): Promise<void> {
    const response = await this.gatewayIpc.listProfiles();
    if (response.success) {
      this.profiles.set(response.data?.data ?? []);
    }
  }
}
