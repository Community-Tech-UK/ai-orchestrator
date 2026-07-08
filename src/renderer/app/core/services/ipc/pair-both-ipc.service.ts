import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import type {
  PairBothCandidate,
  PairBothSessionState,
} from '../../../../../shared/types/pair-both.types';

interface IpcResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { message: string };
}

export interface PairBothCoordinatorStartResult {
  state: PairBothSessionState;
  candidate: PairBothCandidate;
  invitation: string;
}

export interface PairBothWorkerPairingState {
  sessionId: string;
  status: 'confirming';
  shortCode: string;
  candidate: PairBothCandidate;
}

export interface PairBothWorkerConfigSummary {
  nodeId: string;
  name: string;
  coordinatorUrl?: string;
  namespace: string;
  maxConcurrentInstances: number;
  workingDirectories: string[];
}

@Injectable({ providedIn: 'root' })
export class PairBothIpcService {
  private readonly base = inject(ElectronIpcService);
  private get api() { return this.base.getApi(); }

  async startCoordinatorPairing(): Promise<PairBothCoordinatorStartResult> {
    const result = await this.invoke<PairBothCoordinatorStartResult>(
      () => this.api?.pairBothCoordinatorStart(),
      'Failed to start pairing',
    );
    if (!result) {
      throw new Error('Pairing is unavailable outside Electron');
    }
    return result;
  }

  async stopCoordinatorPairing(): Promise<void> {
    await this.invoke(() => this.api?.pairBothCoordinatorStop(), 'Failed to stop pairing');
  }

  async approveCoordinatorPairing(sessionId: string): Promise<PairBothSessionState> {
    const result = await this.invoke<PairBothSessionState>(
      () => this.api?.pairBothCoordinatorApprove(sessionId),
      'Failed to approve pairing',
    );
    if (!result) {
      throw new Error('Pairing approval is unavailable outside Electron');
    }
    return result;
  }

  async rejectCoordinatorPairing(sessionId: string): Promise<PairBothSessionState> {
    const result = await this.invoke<PairBothSessionState>(
      () => this.api?.pairBothCoordinatorReject(sessionId),
      'Failed to reject pairing',
    );
    if (!result) {
      throw new Error('Pairing rejection is unavailable outside Electron');
    }
    return result;
  }

  async getCoordinatorState(): Promise<PairBothSessionState | null> {
    return await this.invoke<PairBothSessionState | null>(
      () => this.api?.pairBothCoordinatorState(),
      'Failed to read pairing state',
    ) ?? null;
  }

  async discoverCandidates(): Promise<PairBothCandidate[]> {
    return await this.invoke<PairBothCandidate[]>(
      () => this.api?.pairBothWorkerDiscover(),
      'Failed to discover Harness computers',
    ) ?? [];
  }

  async connectWorker(candidate: PairBothCandidate): Promise<PairBothWorkerPairingState> {
    const result = await this.invoke<PairBothWorkerPairingState>(
      () => this.api?.pairBothWorkerConnect(candidate),
      'Failed to connect to Harness',
    );
    if (!result) {
      throw new Error('Pairing is unavailable outside Electron');
    }
    return result;
  }

  async confirmWorkerCode(): Promise<void> {
    await this.invoke(() => this.api?.pairBothWorkerConfirmCode(), 'Failed to confirm pairing code');
  }

  async waitForWorkerResult(): Promise<PairBothWorkerConfigSummary> {
    const result = await this.invoke<PairBothWorkerConfigSummary>(
      () => this.api?.pairBothWorkerWaitResult(),
      'Failed to finish pairing',
    );
    if (!result) {
      throw new Error('Pairing result is unavailable outside Electron');
    }
    return result;
  }

  async applyManualPairing(input: string): Promise<PairBothWorkerConfigSummary> {
    const result = await this.invoke<PairBothWorkerConfigSummary>(
      () => this.api?.pairBothWorkerApplyManual(input),
      'Failed to apply pairing details',
    );
    if (!result) {
      throw new Error('Manual pairing is unavailable outside Electron');
    }
    return result;
  }

  parseInvitation(input: string): PairBothCandidate {
    const raw = JSON.parse(input.trim()) as unknown;
    if (!raw || typeof raw !== 'object') {
      throw new Error('Pairing invitation must be a JSON object');
    }
    return raw as PairBothCandidate;
  }

  private async invoke<T>(
    call: () => Promise<unknown> | undefined,
    fallbackMessage: string,
  ): Promise<T | null> {
    const response = await call() as IpcResult<T> | undefined;
    if (!response) {
      return null;
    }
    if (!response.success) {
      throw new Error(response.error?.message ?? fallbackMessage);
    }
    return (response.data ?? null) as T | null;
  }
}
