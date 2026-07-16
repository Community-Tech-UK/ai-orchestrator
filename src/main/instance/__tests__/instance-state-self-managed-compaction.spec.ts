/**
 * InstanceStateManager enriches instance state with the live adapter's
 * `selfManagedAutoCompaction` capability so the renderer can suppress its
 * context-warning banner for adapters that compact themselves (Claude CLI
 * always; Codex in app-server mode). The flag is read lazily from the attached
 * adapter at serialize/flush time, NOT cached — so it reflects the mode
 * resolved after spawn.
 */

import { describe, it, expect, vi } from 'vitest';
import { InstanceStateManager } from '../instance-state';
import {
  BaseCliAdapter,
  type AdapterRuntimeCapabilities,
  type CliCapabilities,
  type CliMessage,
  type CliResponse,
  type CliStatus,
} from '../../cli/adapters/base-cli-adapter';
import type { Instance } from '../../../shared/types/instance.types';
import type { CliAdapter } from '../../cli/adapters/adapter-factory.types';

class CapabilityAdapter extends BaseCliAdapter {
  constructor(private readonly selfManaged: boolean) {
    super({ command: 'test-cli' });
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: this.selfManaged,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: this.selfManaged,
    };
  }

  getName(): string {
    return 'Test';
  }
  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: false,
      fileAccess: false,
      shellExecution: false,
      multiTurn: true,
      vision: false,
      codeExecution: false,
      contextWindow: 1000,
      outputFormats: ['text'],
    };
  }
  async checkStatus(): Promise<CliStatus> {
    return { available: true, version: '0', authenticated: true };
  }
  async sendMessage(_m: CliMessage): Promise<CliResponse> {
    return { id: 'x', content: '', role: 'assistant' };
  }
  // eslint-disable-next-line require-yield
  async *sendMessageStream(_m: CliMessage): AsyncIterable<string> {
    return;
  }
  parseOutput(raw: string): CliResponse {
    return { id: 'x', content: raw, role: 'assistant', raw };
  }
  protected buildArgs(_m: CliMessage): string[] {
    return [];
  }
  protected async sendInputImpl(_m: string): Promise<void> {
    /* no-op */
  }
}

function makeInstance(id: string): Instance {
  return {
    id,
    communicationTokens: new Map(),
  } as unknown as Instance;
}

describe('InstanceStateManager — selfManagesAutoCompaction enrichment', () => {
  it('serializeForIpc reflects the attached adapter capability', () => {
    const mgr = new InstanceStateManager();
    try {
      mgr.setInstance(makeInstance('self'));
      mgr.setInstance(makeInstance('orch'));
      mgr.setAdapter('self', new CapabilityAdapter(true) as unknown as CliAdapter);
      mgr.setAdapter('orch', new CapabilityAdapter(false) as unknown as CliAdapter);

      expect(mgr.serializeForIpc(mgr.getInstance('self')!)['selfManagesAutoCompaction']).toBe(true);
      expect(mgr.serializeForIpc(mgr.getInstance('orch')!)['selfManagesAutoCompaction']).toBe(false);
    } finally {
      mgr.destroy();
    }
  });

  it('omits the flag when no adapter is attached yet (preserves prior renderer value)', () => {
    const mgr = new InstanceStateManager();
    try {
      mgr.setInstance(makeInstance('pending'));
      const serialized = mgr.serializeForIpc(mgr.getInstance('pending')!);
      expect('selfManagesAutoCompaction' in serialized).toBe(false);
    } finally {
      mgr.destroy();
    }
  });

  it('batch flush enriches each update from the live adapter', () => {
    vi.useFakeTimers();
    const mgr = new InstanceStateManager();
    try {
      mgr.setInstance(makeInstance('self'));
      mgr.setAdapter('self', new CapabilityAdapter(true) as unknown as CliAdapter);

      const batches: Array<{ updates: Array<Record<string, unknown>> }> = [];
      mgr.on('batch-update', (b) => batches.push(b));

      mgr.queueUpdate('self', 'busy');
      vi.advanceTimersByTime(200);

      const update = batches.flatMap((b) => b.updates).find((u) => u['instanceId'] === 'self');
      expect(update?.['selfManagesAutoCompaction']).toBe(true);
    } finally {
      mgr.destroy();
      vi.useRealTimers();
    }
  });
});
