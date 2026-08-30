import { Injectable, computed, inject, signal } from '@angular/core';
import { BrowserUnattendedIpcService } from '../../core/services/ipc/browser-unattended-ipc.service';
import type {
  BrowserCampaign,
  BrowserCampaignDetail,
  BrowserCampaignListItem,
  BrowserCampaignStatus,
  BrowserEscalation,
  BrowserVaultStatus,
  BrowserVaultUnlockReason,
  CreateBrowserCampaignPayload,
  CreateCredentialAuthorizationPayload,
  CredentialAuthorization,
  EnrolCredentialPayload,
  EnrolCredentialResult,
} from './browser-unattended.types';

/**
 * Signal-based store for the unattended browser-automation layer: vault
 * status, standing credential authorizations, overnight campaigns, and the
 * escalation triage queue. Writes from HERE go through the approval dialogs and
 * this store is never driven by an agent. Note that credential enrolment and
 * authorization can also be written by an agent through the
 * `aio-mcp browser-credentials` CLI (2026-08-29), so what this store DISPLAYS is
 * not necessarily something a human created.
 */
@Injectable({ providedIn: 'root' })
export class BrowserUnattendedStore {
  private readonly ipc = inject(BrowserUnattendedIpcService);

  private readonly _vaultStatus = signal<BrowserVaultStatus | null>(null);
  private readonly _vaultBusy = signal(false);
  private readonly _vaultUnlockReason = signal<BrowserVaultUnlockReason | null>(null);

  private readonly _authorizations = signal<CredentialAuthorization[]>([]);
  private readonly _campaigns = signal<BrowserCampaignListItem[]>([]);
  private readonly _campaignDetails = signal<Record<string, BrowserCampaignDetail>>({});
  private readonly _escalations = signal<BrowserEscalation[]>([]);

  private readonly _busy = signal(false);
  private readonly _errorMessage = signal<string | null>(null);

  readonly vaultStatus = this._vaultStatus.asReadonly();
  readonly vaultBusy = this._vaultBusy.asReadonly();
  readonly vaultUnlockReason = this._vaultUnlockReason.asReadonly();

  readonly authorizations = this._authorizations.asReadonly();
  readonly campaigns = this._campaigns.asReadonly();
  readonly campaignDetails = this._campaignDetails.asReadonly();
  readonly escalations = this._escalations.asReadonly();

  readonly busy = this._busy.asReadonly();
  readonly errorMessage = this._errorMessage.asReadonly();

  /** Pending escalations only — the morning-triage queue view. */
  readonly pendingEscalations = computed(() =>
    this._escalations().filter((escalation) => escalation.status === 'pending'),
  );

  /** Re-fetch everything: vault status, authorizations, campaigns, escalations. */
  async refreshAll(): Promise<void> {
    await Promise.all([
      this.refreshVaultStatus(),
      this.refreshAuthorizations(),
      this.refreshCampaigns(),
      this.refreshEscalations(),
    ]);
  }

  // ── Vault ───────────────────────────────────────────────────────────────

  async refreshVaultStatus(): Promise<void> {
    const response = await this.ipc.vaultStatus();
    if (!response.success) {
      this.setError(response.error?.message ?? 'Failed to load vault status.');
      return;
    }
    this._vaultStatus.set(response.data ?? null);
  }

  async unlockVault(): Promise<boolean> {
    this._vaultBusy.set(true);
    this._vaultUnlockReason.set(null);
    this._errorMessage.set(null);
    try {
      const response = await this.ipc.vaultUnlock();
      if (!response.success) {
        this.setError(response.error?.message ?? 'Failed to unlock vault.');
        return false;
      }
      const result = response.data;
      if (result && !result.unlocked) {
        this._vaultUnlockReason.set(result.reason ?? null);
      }
      await this.refreshVaultStatus();
      return Boolean(result?.unlocked);
    } finally {
      this._vaultBusy.set(false);
    }
  }

  async lockVault(): Promise<void> {
    this._vaultBusy.set(true);
    this._errorMessage.set(null);
    try {
      const response = await this.ipc.vaultLock();
      if (!response.success) {
        this.setError(response.error?.message ?? 'Failed to lock vault.');
        return;
      }
      this._vaultStatus.set(response.data ?? null);
      this._vaultUnlockReason.set(null);
    } finally {
      this._vaultBusy.set(false);
    }
  }

  // ── Credential authorizations ──────────────────────────────────────────

  async refreshAuthorizations(profileId?: string): Promise<void> {
    const response = await this.ipc.listCredentialAuthorizations(
      profileId ? { profileId } : {},
    );
    if (!response.success) {
      this.setError(response.error?.message ?? 'Failed to load credential authorizations.');
      return;
    }
    this._authorizations.set(response.data ?? []);
  }

  async createAuthorization(payload: CreateCredentialAuthorizationPayload): Promise<boolean> {
    return this.runBusy(async () => {
      const response = await this.ipc.createCredentialAuthorization(payload);
      if (!response.success) {
        this.setError(response.error?.message ?? 'Failed to create credential authorization.');
        return false;
      }
      await this.refreshAuthorizations();
      return true;
    });
  }

  /**
   * Bind an existing vault login to an origin so an authorized fill can use it.
   * Returns the reference + username, or null on failure (message in
   * `errorMessage`). No secret is ever returned.
   */
  async enrolCredential(payload: EnrolCredentialPayload): Promise<EnrolCredentialResult | null> {
    return this.runBusy(async () => {
      const response = await this.ipc.enrolCredential(payload);
      if (!response.success || !response.data) {
        this.setError(response.error?.message ?? 'Failed to enrol the credential.');
        return null;
      }
      return response.data;
    });
  }

  async revokeAuthorization(authorizationId: string): Promise<boolean> {
    return this.runBusy(async () => {
      const response = await this.ipc.revokeCredentialAuthorization({ authorizationId });
      if (!response.success) {
        this.setError(response.error?.message ?? 'Failed to revoke credential authorization.');
        return false;
      }
      // The handler reports `revoked: false` when no such authorization exists.
      // Ignoring it reported success for a no-op, which is the exact harm the
      // CLI door was changed to prevent.
      if (response.data?.revoked === false) {
        this.setError(`No authorization with id '${authorizationId}' exists. Nothing was revoked.`);
        await this.refreshAuthorizations();
        return false;
      }
      await this.refreshAuthorizations();
      return true;
    });
  }

  // ── Campaigns ───────────────────────────────────────────────────────────

  async refreshCampaigns(status?: BrowserCampaignStatus): Promise<void> {
    const response = await this.ipc.listCampaigns(status ? { status } : {});
    if (!response.success) {
      this.setError(response.error?.message ?? 'Failed to load campaigns.');
      return;
    }
    this._campaigns.set(response.data ?? []);
  }

  async loadCampaignDetail(campaignId: string): Promise<void> {
    const response = await this.ipc.getCampaign({ campaignId });
    if (!response.success || !response.data) {
      this.setError(response.error?.message ?? 'Failed to load campaign detail.');
      return;
    }
    const detail = response.data;
    this._campaignDetails.update((current) => ({ ...current, [campaignId]: detail }));
  }

  async createCampaign(payload: CreateBrowserCampaignPayload): Promise<boolean> {
    return this.runBusy(async () => {
      const response = await this.ipc.createCampaign(payload);
      if (!response.success) {
        this.setError(response.error?.message ?? 'Failed to create campaign.');
        return false;
      }
      await this.refreshCampaigns();
      return true;
    });
  }

  async pauseCampaign(campaignId: string): Promise<boolean> {
    return this.applyCampaignTransition(campaignId, () => this.ipc.pauseCampaign({ campaignId }));
  }

  async resumeCampaign(campaignId: string): Promise<boolean> {
    return this.applyCampaignTransition(campaignId, () => this.ipc.resumeCampaign({ campaignId }));
  }

  async killCampaign(campaignId: string): Promise<boolean> {
    return this.applyCampaignTransition(campaignId, () => this.ipc.killCampaign({ campaignId }));
  }

  async approveDeclaration(campaignId: string, declarationHash: string): Promise<boolean> {
    return this.runBusy(async () => {
      const response = await this.ipc.approveCampaignDeclaration({ campaignId, declarationHash });
      if (!response.success) {
        this.setError(response.error?.message ?? 'Failed to approve declaration hash.');
        return false;
      }
      await this.loadCampaignDetail(campaignId);
      return true;
    });
  }

  // ── Escalations ─────────────────────────────────────────────────────────

  async refreshEscalations(filter?: { campaignId?: string; profileId?: string }): Promise<void> {
    const response = await this.ipc.listEscalations({ ...filter, status: 'pending' });
    if (!response.success) {
      this.setError(response.error?.message ?? 'Failed to load escalations.');
      return;
    }
    this._escalations.set(response.data ?? []);
  }

  async resolveEscalation(escalationId: string, note?: string): Promise<boolean> {
    return this.runBusy(async () => {
      const response = await this.ipc.resolveEscalation({ escalationId, note });
      if (!response.success) {
        this.setError(response.error?.message ?? 'Failed to resolve escalation.');
        return false;
      }
      this.removeEscalation(escalationId);
      return true;
    });
  }

  async skipEscalation(escalationId: string, note?: string): Promise<boolean> {
    return this.runBusy(async () => {
      const response = await this.ipc.skipEscalation({ escalationId, note });
      if (!response.success) {
        this.setError(response.error?.message ?? 'Failed to skip escalation.');
        return false;
      }
      this.removeEscalation(escalationId);
      return true;
    });
  }

  clearError(): void {
    this._errorMessage.set(null);
  }

  private removeEscalation(escalationId: string): void {
    this._escalations.update((current) =>
      current.filter((escalation) => escalation.id !== escalationId),
    );
  }

  private async applyCampaignTransition(
    campaignId: string,
    call: () => Promise<{ success: boolean; data?: BrowserCampaign; error?: { message: string } }>,
  ): Promise<boolean> {
    return this.runBusy(async () => {
      const response = await call();
      if (!response.success) {
        this.setError(response.error?.message ?? 'Failed to update campaign.');
        return false;
      }
      await this.refreshCampaigns();
      if (this._campaignDetails()[campaignId]) {
        await this.loadCampaignDetail(campaignId);
      }
      return true;
    });
  }

  private async runBusy<T>(fn: () => Promise<T>): Promise<T> {
    this._busy.set(true);
    this._errorMessage.set(null);
    try {
      return await fn();
    } finally {
      this._busy.set(false);
    }
  }

  private setError(message: string): void {
    this._errorMessage.set(message);
  }
}
