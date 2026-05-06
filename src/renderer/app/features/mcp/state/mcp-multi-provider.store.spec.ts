import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpIpcService } from '../../../core/services/ipc/mcp-ipc.service';
import { McpMultiProviderStore } from './mcp-multi-provider.store';

describe('McpMultiProviderStore', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: McpIpcService,
          useValue: {
            getMultiProviderState: vi.fn().mockResolvedValue({
              success: true,
              data: {
                orchestrator: [],
                shared: [],
                providers: [
                  {
                    provider: 'claude',
                    cliAvailable: true,
                    servers: [{ id: 'claude:user:fs', name: 'fs', scope: 'user' }],
                  },
                ],
                stateVersion: 1,
              },
            }),
            onMultiProviderStateChanged: vi.fn().mockReturnValue(() => undefined),
          },
        },
      ],
    });
  });

  it('refreshes and exposes provider tab state', async () => {
    const store = TestBed.inject(McpMultiProviderStore);
    await store.refresh();
    expect(store.providerTab('claude')()?.servers[0]?.name).toBe('fs');
  });
});
