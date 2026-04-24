/**
 * RuntimeReadinessCoordinator
 *
 * Isolates lifecycle readiness checks that decide whether a spawned adapter is
 * usable, whether native resume actually stabilized, and whether stdin can
 * accept the next input.
 */

import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { AdapterRuntimeCapabilities } from '../../cli/adapters/base-cli-adapter';
import { getLogger } from '../../logging/logger';
import { observeAdapterRuntimeEvents } from '../../providers/adapter-runtime-event-bridge';
import type { Instance } from '../../../shared/types/instance.types';

const logger = getLogger('RuntimeReadiness');

const DEFAULT_RUNTIME_CAPABILITIES: AdapterRuntimeCapabilities = {
  supportsResume: false,
  supportsForkSession: false,
  supportsNativeCompaction: false,
  supportsPermissionPrompts: false,
  supportsDeferPermission: false,
};

export interface RuntimeReadinessDeps {
  getInstance: (instanceId: string) => Pick<Instance, 'processId' | 'status'> | undefined;
  getAdapter: (instanceId: string) => CliAdapter | undefined;
}

export class RuntimeReadinessCoordinator {
  constructor(private readonly deps: RuntimeReadinessDeps) {}

  getAdapterRuntimeCapabilities(adapter?: CliAdapter): AdapterRuntimeCapabilities {
    if (
      adapter &&
      'getRuntimeCapabilities' in adapter &&
      typeof adapter.getRuntimeCapabilities === 'function'
    ) {
      return adapter.getRuntimeCapabilities();
    }

    return { ...DEFAULT_RUNTIME_CAPABILITIES };
  }

  /**
   * Wait until the just-spawned CLI proves it accepted native resume.
   *
   * Positive signal: any normalized output event from the adapter.
   * Negative signal: process liveness failure or a session-not-found error.
   */
  async waitForResumeHealth(
    instanceId: string,
    timeoutMs = 5000,
    pollIntervalMs = 200,
  ): Promise<boolean> {
    const adapter = this.deps.getAdapter(instanceId);
    if (!this.isLive(instanceId, adapter)) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let stopObserving: () => void = () => undefined;

      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        stopObserving();
        resolve(value);
      };

      const poll = setInterval(() => {
        if (!this.isLive(instanceId, adapter)) {
          finish(false);
        }
      }, pollIntervalMs);

      const timer = setTimeout(() => finish(false), timeoutMs);

      stopObserving = observeAdapterRuntimeEvents(adapter, ({ event }) => {
        switch (event.kind) {
          case 'output':
            finish(true);
            break;
          case 'error':
            if (/no conversation found/i.test(event.message) || /session.*not.*found/i.test(event.message)) {
              finish(false);
            }
            break;
          default:
            break;
        }
      });
    });
  }

  /**
   * Wait for the adapter's input pipe to become writable after spawn/respawn.
   *
   * Claude's persistent process exposes this through its formatter; exec-based
   * adapters are ready once spawn returns.
   */
  async waitForAdapterWritable(
    instanceId: string,
    timeoutMs = 3000,
    pollIntervalMs = 100,
  ): Promise<boolean> {
    const isWritable = (): boolean => {
      const adapter = this.deps.getAdapter(instanceId);
      if (!adapter) {
        return false;
      }

      if (adapter.getName() === 'claude-cli') {
        const formatter = (adapter as unknown as {
          formatter?: { isWritable(): boolean } | null;
        }).formatter;
        return formatter !== undefined && formatter !== null && formatter.isWritable();
      }

      return true;
    };

    if (isWritable()) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        clearInterval(poll);
      };

      const timeout = setTimeout(() => {
        cleanup();
        logger.debug('waitForAdapterWritable timed out, proceeding anyway', { instanceId });
        resolve(isWritable());
      }, timeoutMs);

      const poll = setInterval(() => {
        if (isWritable()) {
          cleanup();
          resolve(true);
        }
      }, pollIntervalMs);
    });
  }

  async waitForInputReadinessBoundary(
    instanceId: string,
    adapter?: CliAdapter,
  ): Promise<void> {
    const capabilities = this.getAdapterRuntimeCapabilities(
      adapter ?? this.deps.getAdapter(instanceId),
    );
    if (!capabilities.supportsPermissionPrompts && !capabilities.supportsDeferPermission) {
      return;
    }

    await this.waitForAdapterWritable(instanceId, 3_000);
  }

  private isLive(instanceId: string, adapter?: CliAdapter): adapter is CliAdapter {
    if (!adapter) {
      return false;
    }

    const instance = this.deps.getInstance(instanceId);
    const currentAdapter = this.deps.getAdapter(instanceId);
    if (!instance || currentAdapter !== adapter) {
      return false;
    }

    return (
      instance.processId !== null &&
      instance.status !== 'error' &&
      instance.status !== 'failed' &&
      instance.status !== 'terminated'
    );
  }
}
