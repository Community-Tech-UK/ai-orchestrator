import { computed, Injectable, inject, signal } from '@angular/core';
import type { CampaignRunDto } from '../../../../main/orchestration/campaign.types';
import { CampaignIpcService } from '../services/ipc/campaign-ipc.service';

@Injectable({ providedIn: 'root' })
export class CampaignStore {
  private ipc = inject(CampaignIpcService);

  private campaigns = signal<CampaignRunDto[]>([]);
  private loading = signal(false);
  private error = signal<string | null>(null);
  private wired = false;

  readonly allCampaigns = computed(() => this.campaigns());
  readonly isLoading = computed(() => this.loading());
  readonly lastError = computed(() => this.error());

  readonly activeCampaigns = computed(() =>
    this.campaigns().filter((c) => c.status === 'running' || c.status === 'paused' || c.status === 'pending')
  );

  ensureWired(): void {
    if (this.wired) return;
    this.wired = true;
    this.ipc.onStateChanged(({ campaignId, campaign }) => {
      if (!campaignId || !campaign) return;
      this.campaigns.update((list) => {
        const idx = list.findIndex((c) => c.id === campaignId);
        if (idx >= 0) {
          const next = [...list];
          next[idx] = campaign;
          return next;
        }
        return [campaign, ...list];
      });
    });
  }

  async load(limit = 50): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.ipc.list(limit);
      if (res.success && res.data) {
        this.campaigns.set(res.data.campaigns);
      } else {
        this.error.set(res.error?.message ?? 'Failed to load campaigns');
      }
    } finally {
      this.loading.set(false);
    }
  }

  async halt(campaignId: string): Promise<void> {
    await this.ipc.halt(campaignId);
  }

  async resume(campaignId: string): Promise<void> {
    await this.ipc.resume(campaignId);
  }
}
