import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRuntimeService } from './provider-runtime-service';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliCapabilities, CliStatus } from '../cli/adapters/base-cli-adapter';
import type { AppSettings } from '../../shared/types/settings.types';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import {
  _resetHardenedModeScopingForTesting,
  setInstanceHardened,
} from '../instance/lifecycle/hardened-mode-scoping';

function makeAdapter(name: string): CliAdapter {
  return {
    getName: () => name,
    getCapabilities: (): CliCapabilities => ({
      streaming: true,
      toolUse: false,
      fileAccess: false,
      shellExecution: false,
      multiTurn: true,
      vision: false,
      codeExecution: false,
      contextWindow: 1,
      outputFormats: ['text'],
    }),
    checkStatus: async (): Promise<CliStatus> => ({ available: true }),
    sendMessage: vi.fn(),
    sendMessageStream: vi.fn(),
    parseOutput: vi.fn(),
    sendInput: vi.fn(),
    spawn: vi.fn(),
    terminate: vi.fn(),
    interrupt: vi.fn(),
    getSessionId: vi.fn(),
    setSessionId: vi.fn(),
    isRunning: vi.fn(),
    getPid: vi.fn(),
    getConfig: vi.fn(),
    getSpawnMode: vi.fn(),
    getRuntimeCapabilities: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
  } as unknown as CliAdapter;
}

describe('ProviderRuntimeService spawn worker offload gate', () => {
  beforeEach(() => _resetHardenedModeScopingForTesting());
  afterEach(() => _resetHardenedModeScopingForTesting());

  it('adds a default-off settings flag', () => {
    expect(DEFAULT_SETTINGS.enableSpawnWorkerOffload).toBe(false);
  });

  it('uses the normal adapter creator when the setting is disabled', () => {
    const normal = makeAdapter('normal');
    const service = new ProviderRuntimeService({
      registry: {
        recordAvailable: vi.fn(),
        recordUnavailable: vi.fn(),
      } as never,
      createAdapter: vi.fn(() => normal),
      settings: {
        get: <K extends keyof AppSettings>(key: K): AppSettings[K] =>
          ({ ...DEFAULT_SETTINGS, enableSpawnWorkerOffload: false })[key],
      },
    });

    const adapter = service.createAdapter({
      cliType: 'claude',
      options: { workingDirectory: '/repo' },
    });

    expect(adapter).toBe(normal);
  });

  it('returns a worker proxy for local Claude and Gemini when enabled', () => {
    const service = new ProviderRuntimeService({
      registry: {
        recordAvailable: vi.fn(),
        recordUnavailable: vi.fn(),
      } as never,
      createAdapter: vi.fn(() => makeAdapter('normal')),
      settings: {
        get: <K extends keyof AppSettings>(key: K): AppSettings[K] =>
          ({ ...DEFAULT_SETTINGS, enableSpawnWorkerOffload: true })[key],
      },
    });

    const claude = service.createAdapter({
      cliType: 'claude',
      options: { workingDirectory: '/repo', instanceId: 'inst-1' },
    });
    const gemini = service.createAdapter({
      cliType: 'gemini',
      options: { workingDirectory: '/repo', instanceId: 'inst-2' },
    });

    expect(claude.getName()).toBe('claude-cli');
    expect(gemini.getName()).toBe('gemini-cli');
    expect(claude.getSpawnMode()).toBe('subprocess-stream');
    expect(gemini.getSpawnMode()).toBe('subprocess-exec');
  });

  it('does not proxy remote execution locations', () => {
    const normal = makeAdapter('normal');
    const service = new ProviderRuntimeService({
      registry: {
        recordAvailable: vi.fn(),
        recordUnavailable: vi.fn(),
      } as never,
      createAdapter: vi.fn(() => normal),
      settings: {
        get: <K extends keyof AppSettings>(key: K): AppSettings[K] =>
          ({ ...DEFAULT_SETTINGS, enableSpawnWorkerOffload: true })[key],
      },
    });

    const adapter = service.createAdapter({
      cliType: 'claude',
      options: { workingDirectory: '/repo' },
      executionLocation: { type: 'remote', nodeId: 'node-1' },
    });

    expect(adapter).toBe(normal);
  });

  it('keeps hardened Claude on the normal adapter path so Seatbelt is applied', () => {
    setInstanceHardened('hardened-claude', true);
    const service = new ProviderRuntimeService({
      registry: {
        recordAvailable: vi.fn(),
        recordUnavailable: vi.fn(),
      } as never,
      settings: {
        get: <K extends keyof AppSettings>(key: K): AppSettings[K] =>
          ({ ...DEFAULT_SETTINGS, enableSpawnWorkerOffload: true })[key],
      },
    });

    const adapter = service.createAdapter({
      cliType: 'claude',
      options: { workingDirectory: '/repo', instanceId: 'hardened-claude' },
    }) as unknown as { hardenedMode: { writableRoots: string[] } | null };

    expect(adapter.hardenedMode?.writableRoots).toContain('/repo');
  });

  it('keeps hardened Gemini on the normal adapter path so unsupported providers fail closed', () => {
    setInstanceHardened('hardened-gemini', true);
    const service = new ProviderRuntimeService({
      registry: {
        recordAvailable: vi.fn(),
        recordUnavailable: vi.fn(),
      } as never,
      settings: {
        get: <K extends keyof AppSettings>(key: K): AppSettings[K] =>
          ({ ...DEFAULT_SETTINGS, enableSpawnWorkerOffload: true })[key],
      },
    });

    expect(() => service.createAdapter({
      cliType: 'gemini',
      options: { workingDirectory: '/repo', instanceId: 'hardened-gemini' },
    })).toThrow('Hardened mode is not supported for Gemini yet');
  });
});
