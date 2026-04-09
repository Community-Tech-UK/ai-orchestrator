import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-home'),
    getAppPath: vi.fn().mockReturnValue('/tmp/test-app'),
  },
}));

vi.mock('../orchestration/multi-verify-coordinator', () => ({
  getMultiVerifyCoordinator: () => ({
    on: vi.fn(),
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  _resetOrchestratorPluginManagerForTesting,
  OrchestratorPluginManager,
} from './plugin-manager';
import type { TypedOrchestratorHooks } from '../../shared/types/plugin.types';

beforeEach(() => {
  _resetOrchestratorPluginManagerForTesting();
});

describe('OrchestratorPluginManager', () => {
  it('accepts typed hook payloads at compile time', () => {
    const hooks: TypedOrchestratorHooks = {
      'instance.created': (payload) => {
        const instanceId: string = payload.instanceId;
        const workingDirectory: string = payload.workingDirectory;
        void instanceId;
        void workingDirectory;
      },
      'instance.output': (payload) => {
        const instanceId: string = payload.instanceId;
        const messageId: string = payload.message.id;
        void instanceId;
        void messageId;
      },
      'verification.error': (payload) => {
        const verificationId: string = payload.verificationId;
        void verificationId;
      },
    };

    expect(Object.keys(hooks)).toHaveLength(3);
  });

  it('dispatches typed payloads to the matching plugin hook', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const hook = vi.fn();
    const ctx = {
      instanceManager: {} as never,
      appPath: '/tmp/test-app',
      homeDir: '/tmp/test-home',
    };

    vi.spyOn(
      manager as unknown as {
        getPlugins: (workingDirectory: string, pluginCtx: unknown) => Promise<unknown[]>;
      },
      'getPlugins',
    ).mockResolvedValue([
      {
        filePath: '/tmp/plugin.js',
        hooks: {
          'instance.output': hook,
        },
      },
    ]);

    await (
      manager as unknown as {
        emitToPlugins: (
          workingDirectory: string,
          pluginCtx: typeof ctx,
          event: 'instance.output',
          payload: { instanceId: string; message: { id: string } },
        ) => Promise<void>;
      }
    ).emitToPlugins('/tmp/project', ctx, 'instance.output', {
      instanceId: 'inst-1',
      message: { id: 'msg-1' } as never,
    });

    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'inst-1',
        message: expect.objectContaining({ id: 'msg-1' }),
      }),
    );
  });

  it('swallows plugin hook errors so one plugin cannot crash dispatch', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const ctx = {
      instanceManager: {} as never,
      appPath: '/tmp/test-app',
      homeDir: '/tmp/test-home',
    };

    vi.spyOn(
      manager as unknown as {
        getPlugins: (workingDirectory: string, pluginCtx: unknown) => Promise<unknown[]>;
      },
      'getPlugins',
    ).mockResolvedValue([
      {
        filePath: '/tmp/plugin.js',
        hooks: {
          'instance.removed': vi.fn().mockRejectedValue(new Error('boom')),
        },
      },
    ]);

    await expect(
      (
        manager as unknown as {
          emitToPlugins: (
            workingDirectory: string,
            pluginCtx: typeof ctx,
            event: 'instance.removed',
            payload: { instanceId: string },
          ) => Promise<void>;
        }
      ).emitToPlugins('/tmp/project', ctx, 'instance.removed', {
        instanceId: 'inst-1',
      }),
    ).resolves.toBeUndefined();
  });
});
