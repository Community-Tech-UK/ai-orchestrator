import { Injectable, computed, inject, signal } from '@angular/core';
import { McpIpcService } from '../../../core/services/ipc/mcp-ipc.service';
import type { IpcResponse } from '../../../core/services/ipc/electron-ipc.service';
import type {
  McpMultiProviderStateDto,
  OrchestratorMcpDto,
  ProviderTabDto,
} from '../../../../../shared/types/mcp-dtos.types';
import type { SupportedProvider } from '../../../../../shared/types/mcp-scopes.types';

const EMPTY_STATE: McpMultiProviderStateDto = {
  orchestrator: [],
  providers: [],
  stateVersion: 0,
};

@Injectable({ providedIn: 'root' })
export class McpMultiProviderStore {
  private readonly ipc = inject(McpIpcService);
  private readonly _state = signal<McpMultiProviderStateDto>(EMPTY_STATE);
  private readonly _error = signal<string | null>(null);

  readonly state = this._state.asReadonly();
  readonly error = this._error.asReadonly();
  readonly orchestrator = computed<readonly OrchestratorMcpDto[]>(() => this._state().orchestrator);

  constructor() {
    this.ipc.onMultiProviderStateChanged((state) => {
      this._state.set(state);
      this._error.set(null);
    });
  }

  async refresh(): Promise<void> {
    await this.load(() => this.ipc.getMultiProviderState());
  }

  async manualRefresh(): Promise<void> {
    await this.load(() => this.ipc.refreshMultiProviderState());
  }

  private async load(read: () => Promise<IpcResponse<McpMultiProviderStateDto>>): Promise<void> {
    try {
      const response = await read();
      if (!response.success || !response.data) throw new Error('Tool server settings were not returned.');
      this._state.set(response.data);
      this._error.set(null);
    } catch {
      this._error.set('Could not load tool server settings. Refresh to try again.');
    }
  }

  providerTab(provider: SupportedProvider) {
    return computed<ProviderTabDto | undefined>(
      () => this._state().providers.find((tab) => tab.provider === provider),
    );
  }
}
