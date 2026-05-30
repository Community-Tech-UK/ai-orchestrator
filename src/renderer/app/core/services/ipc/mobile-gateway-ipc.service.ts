/**
 * Mobile Gateway IPC Service
 * Thin renderer wrapper over the preload `mobileGateway*` methods.
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import type {
  MobileGatewayStatus,
  MobileDeviceSummary,
} from '../../../../../shared/types/mobile-gateway.types';

/** Result of issuing a pairing credential (includes a ready-to-render QR). */
export interface MobilePairingResult {
  pairingToken: string;
  expiresAt: number;
  host: string;
  port: number;
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

  async issuePairing(): Promise<MobilePairingResult | null> {
    const res = await this.ipc.getApi()?.mobileGatewayIssuePairing();
    return res?.success ? (res.data as MobilePairingResult) : null;
  }

  async listDevices(): Promise<MobileDeviceSummary[]> {
    const res = await this.ipc.getApi()?.mobileGatewayListDevices();
    return res?.success ? (res.data as MobileDeviceSummary[]) : [];
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const res = await this.ipc.getApi()?.mobileGatewayRevokeDevice({ deviceId });
    return Boolean(res?.success && (res.data as { revoked?: boolean })?.revoked);
  }
}
