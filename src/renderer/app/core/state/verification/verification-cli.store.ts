/**
 * Verification CLI Store - Manages CLI detection state
 */

import { Injectable, inject } from '@angular/core';
import { IpcFacadeService } from '../../services/ipc';
import { VerificationStateService } from './verification-state.service';
import type { CliDetectionResult } from './verification.types';

@Injectable({ providedIn: 'root' })
export class VerificationCliStore {
  private stateService = inject(VerificationStateService);
  private ipc = inject(IpcFacadeService);

  /**
   * Scan for available CLIs
   */
  async scanClis(force = false): Promise<void> {
    this.stateService.setScanning(true);

    try {
      const result = await this.ipc.invoke<CliDetectionResult>(
        'cli:detect-all',
        { force }
      );

      if (result.success && result.data) {
        this.stateService.setCliDetection(result.data);
      } else {
        throw new Error(result.error?.message || 'Failed to detect CLIs');
      }
    } catch (error) {
      this.stateService.setScanning(false, (error as Error).message);
    }
  }

  /**
   * Test CLI connection
   */
  async testCliConnection(command: string): Promise<boolean> {
    try {
      const result = await this.ipc.invoke<{ success: boolean }>(
        'cli:test-connection',
        { command }
      );
      return result.success && result.data?.success === true;
    } catch {
      return false;
    }
  }
}
