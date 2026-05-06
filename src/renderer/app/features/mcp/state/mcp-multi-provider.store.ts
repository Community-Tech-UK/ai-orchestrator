import { Injectable, computed, inject, signal } from '@angular/core';
import { McpIpcService } from '../../../core/services/ipc/mcp-ipc.service';
import type {
  McpMultiProviderStateDto,
  OrchestratorMcpDto,
  ProviderTabDto,
  SharedMcpDto,
} from '../../../../../shared/types/mcp-dtos.types';
import type { SupportedProvider } from '../../../../../shared/types/mcp-scopes.types';

const EMPTY_STATE: McpMultiProviderStateDto = {
  orchestrator: [],
  shared: [],
  providers: [],
  stateVersion: 0,
};

@Injectable({ providedIn: 'root' })
export class McpMultiProviderStore {
  private readonly ipc = inject(McpIpcService);
  private readonly _state = signal<McpMultiProviderStateDto>(EMPTY_STATE);

  readonly state = this._state.asReadonly();
  readonly orchestrator = computed<readonly OrchestratorMcpDto[]>(() => this._state().orchestrator);
  readonly shared = computed<readonly SharedMcpDto[]>(() => this._state().shared);

  constructor() {
    this.ipc.onMultiProviderStateChanged((state) => {
      this._state.set(state);
    });
  }

  async refresh(): Promise<void> {
    const response = await this.ipc.getMultiProviderState();
    if (response.success && response.data) {
      this._state.set(response.data);
    }
  }

  async manualRefresh(): Promise<void> {
    const response = await this.ipc.refreshMultiProviderState();
    if (response.success && response.data) {
      this._state.set(response.data);
    }
  }

  providerTab(provider: SupportedProvider) {
    return computed<ProviderTabDto | undefined>(
      () => this._state().providers.find((tab) => tab.provider === provider),
    );
  }
}
