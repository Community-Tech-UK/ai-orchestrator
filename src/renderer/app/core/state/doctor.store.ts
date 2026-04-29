import { Injectable, signal, inject } from '@angular/core';
import type {
  DoctorReport,
  DoctorSectionId,
  OperatorArtifactExportRequest,
  OperatorArtifactExportResult,
} from '../../../../shared/types/diagnostics.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class DoctorStore {
  private readonly ipc = inject(ElectronIpcService);
  private readonly _report = signal<DoctorReport | null>(null);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _activeSection = signal<DoctorSectionId>('startup-capabilities');

  readonly report = this._report.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly activeSection = this._activeSection.asReadonly();

  async load(payload: { workingDirectory?: string; force?: boolean } = {}): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.diagnosticsGetDoctorReport) {
      this._error.set('Diagnostics IPC is unavailable.');
      return;
    }

    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await api.diagnosticsGetDoctorReport(payload);
      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? 'Failed to load Doctor report');
      }
      this._report.set(response.data as DoctorReport);
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this._loading.set(false);
    }
  }

  setActiveSection(section: DoctorSectionId): void {
    this._activeSection.set(section);
  }

  async exportBundle(payload: OperatorArtifactExportRequest): Promise<OperatorArtifactExportResult> {
    const api = this.ipc.getApi();
    if (!api?.diagnosticsExportArtifactBundle) {
      throw new Error('Diagnostics export IPC is unavailable.');
    }

    const response = await api.diagnosticsExportArtifactBundle(payload);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? 'Failed to export diagnostics bundle');
    }
    return response.data as OperatorArtifactExportResult;
  }

  async revealBundle(bundlePath: string): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.diagnosticsRevealBundle) {
      throw new Error('Diagnostics reveal IPC is unavailable.');
    }

    const response = await api.diagnosticsRevealBundle({ bundlePath });
    if (!response.success) {
      throw new Error(response.error?.message ?? 'Failed to reveal diagnostics bundle');
    }
  }
}
