import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type {
  InstructionMigrationDraft,
  InstructionResolution,
} from '../../../../../shared/types/instruction-source.types';

@Injectable({ providedIn: 'root' })
export class InstructionIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async resolveInstructions(
    workingDirectory: string,
    contextPaths?: string[],
  ): Promise<IpcResponse<InstructionResolution>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.instructionsResolve(
      workingDirectory,
      contextPaths,
    ) as Promise<IpcResponse<InstructionResolution>>;
  }

  async createInstructionDraft(
    workingDirectory: string,
    contextPaths?: string[],
  ): Promise<IpcResponse<{ resolution: InstructionResolution } & InstructionMigrationDraft>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.instructionsCreateDraft(
      workingDirectory,
      contextPaths,
    ) as Promise<IpcResponse<{ resolution: InstructionResolution } & InstructionMigrationDraft>>;
  }
}
