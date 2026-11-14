/**
 * Mobile Gateway IPC Service
 * Thin renderer wrapper over the preload `mobileGateway*` methods.
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import { presentError } from '../../../../../shared/present-error';
import type {
  MobileGatewayStatus,
  MobileDeviceSummary,
  MobilePeopleOverview,
} from '../../../../../shared/types/mobile-gateway.types';

/** Result of issuing a pairing credential (includes a ready-to-render QR). */
export interface MobilePairingResult {
  pairingToken: string;
  expiresAt: number;
  host: string;
  port: number;
  /** True when the gateway is serving TLS — the phone should connect over wss/https. */
  secure?: boolean;
  qrDataUrl: string;
}

@Injectable({ providedIn: 'root' })
export class MobileGatewayIpcService {
  private readonly ipc = inject(ElectronIpcService);

  async getStatus(): Promise<MobileGatewayStatus | null> {
    const res = await this.ipc.getApi()?.mobileGatewayGetStatus();
    return res?.success ? (res.data as MobileGatewayStatus) : null;
  }

  async start(): Promise<MobileGatewayStatus | null> {
    const res = await this.ipc.getApi()?.mobileGatewayStart();
    return res?.success ? (res.data as MobileGatewayStatus) : null;
  }

  async stop(): Promise<MobileGatewayStatus | null> {
    const res = await this.ipc.getApi()?.mobileGatewayStop();
    return res?.success ? (res.data as MobileGatewayStatus) : null;
  }

  /** A pairing code for the owner's phone, or for a named person's phone. */
  async issuePairing(profileId?: string): Promise<MobilePairingResult | null> {
    const res = await this.ipc.getApi()?.mobileGatewayIssuePairing(profileId ? { profileId } : undefined);
    return res?.success ? (res.data as MobilePairingResult) : null;
  }

  async listPeople(): Promise<MobilePeopleOverview | null> {
    const res = await this.ipc.getApi()?.mobileGatewayListPeople();
    return res?.success ? (res.data as MobilePeopleOverview) : null;
  }

  /** Throws with the reason when the name is not accepted. */
  async addPerson(name: string): Promise<void> {
    const res = await this.ipc.getApi()?.mobileGatewayAddPerson({ name });
    if (!res?.success) throw new Error(presentError(res?.error).rawDetail || 'Could not add this person.');
  }

  async removePerson(profileId: string): Promise<boolean> {
    const res = await this.ipc.getApi()?.mobileGatewayRemovePerson({ profileId });
    return Boolean(res?.success && (res.data as { removed?: boolean })?.removed);
  }

  /** Throws with the reason when the choices are not accepted. */
  async setPersonSession(settings: {
    profileId: string;
    workerNodeId: string;
    workingDirectory: string;
    allowedAccountProfileIds: string[];
  }): Promise<void> {
    const res = await this.ipc.getApi()?.mobileGatewaySetPersonSession(settings);
    if (!res?.success) throw new Error(presentError(res?.error).rawDetail || 'Could not save these choices.');
  }

  async listDevices(): Promise<MobileDeviceSummary[]> {
    const res = await this.ipc.getApi()?.mobileGatewayListDevices();
    return res?.success ? (res.data as MobileDeviceSummary[]) : [];
  }

  /** The user opened this session on the desktop, so the phone's "finished" item goes. */
  async markViewed(instanceId: string): Promise<void> {
    await this.ipc.getApi()?.mobileGatewayMarkViewed({ instanceId });
  }

  /** Called when the phone opens or dismisses a session. */
  onCompletionViewed(callback: (instanceId: string) => void): () => void {
    const api = this.ipc.getApi();
    if (!api) return () => { /* not in Electron */ };
    return api.onMobileGatewayCompletionViewed(({ instanceId }) => callback(instanceId));
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const res = await this.ipc.getApi()?.mobileGatewayRevokeDevice({ deviceId });
    return Boolean(res?.success && (res.data as { revoked?: boolean })?.revoked);
  }
}
