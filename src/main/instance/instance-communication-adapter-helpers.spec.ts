import { describe, expect, it } from 'vitest';

import type { CliAdapter } from '../cli/adapters/adapter-factory';
import {
  BaseCliAdapter,
  type AdapterCapabilities,
  type AdapterRuntimeCapabilities,
  type CliCapabilities,
  type CliMessage,
  type CliResponse,
  type CliStatus,
} from '../cli/adapters/base-cli-adapter';
import { isStatelessExecAdapter } from './instance-communication-adapter-helpers';

function fakeAdapter(name: string): CliAdapter {
  return {
    getName: () => name,
  } as unknown as CliAdapter;
}

/**
 * LT-004: minimal concrete adapter whose resident-session/native-compaction
 * capabilities flip live, mirroring Codex app-server's `useAppServer`-derived
 * `getAdapterCapabilities()`/`getRuntimeCapabilities()`. Used to prove
 * `isStatelessExecAdapter` correctly reads the adapter's CURRENT runtime mode
 * (not a static provider-name assumption) at any point in time.
 */
class ResidentToggleAdapter extends BaseCliAdapter {
  resident = false;

  constructor() {
    super({ command: 'test-cli' });
  }

  getName(): string {
    return 'codex-cli';
  }
  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: false,
      codeExecution: true,
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

  override getAdapterCapabilities(): AdapterCapabilities {
    return { residentSession: this.resident, liveInterrupt: this.resident, liveSteer: this.resident };
  }
  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: true,
      supportsForkSession: false,
      supportsNativeCompaction: this.resident,
      selfManagedAutoCompaction: this.resident,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
    };
  }
}

describe('instance communication adapter helpers', () => {
  it('classifies Antigravity as a stateless exec adapter', () => {
    expect(isStatelessExecAdapter(fakeAdapter('antigravity-cli'))).toBe(true);
  });

  it('does not classify ACP-backed adapters as stateless just because their name includes a stateless provider', () => {
    expect(isStatelessExecAdapter(fakeAdapter('copilot-acp'))).toBe(false);
  });

  it('LT-004: does not classify a Codex-named adapter as stateless while it reports an active resident session', () => {
    const adapter = new ResidentToggleAdapter();
    adapter.resident = true;
    expect(isStatelessExecAdapter(adapter as unknown as CliAdapter)).toBe(false);
  });

  it('LT-004: classifies the same Codex-named adapter as stateless once it no longer reports a resident session', () => {
    const adapter = new ResidentToggleAdapter();
    adapter.resident = false;
    expect(isStatelessExecAdapter(adapter as unknown as CliAdapter)).toBe(true);
  });
});
