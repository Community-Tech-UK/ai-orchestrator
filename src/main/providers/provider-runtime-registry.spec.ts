import { describe, expect, it, vi } from 'vitest';
import type { DiagnosisResult, ProbeResult } from './provider-doctor';
import { ProviderRuntimeRegistry, normalizeDiagnosisProvider } from './provider-runtime-registry';
import { ProviderRuntimeService } from './provider-runtime-service';
import type { AdapterRuntimeCapabilities } from '../cli/adapters/base-cli-adapter';

const capabilities: AdapterRuntimeCapabilities = {
  supportsResume: true,
  supportsForkSession: false,
  supportsNativeCompaction: true,
  supportsPermissionPrompts: true,
  supportsDeferPermission: false,
  selfManagedAutoCompaction: false,
};

function probe(
  name: string,
  status: ProbeResult['status'],
  overrides: Partial<ProbeResult> = {},
): ProbeResult {
  return {
    name,
    status,
    message: `${name} ${status}`,
    latencyMs: 0,
    ...overrides,
  };
}

function diagnosis(
  provider: string,
  overall: DiagnosisResult['overall'],
  probes: ProbeResult[],
): DiagnosisResult {
  return {
    provider,
    overall,
    probes,
    recommendations: [],
    repairActions: [],
    timestamp: 1234,
  };
}

describe('ProviderRuntimeRegistry', () => {
  it('preserves plugin provider ids when normalizing diagnosis keys', () => {
    expect(normalizeDiagnosisProvider('plugin:acme-cli')).toBe('plugin:acme-cli');
  });

  it('records an available runtime snapshot and emits a typed lifecycle event', () => {
    const registry = new ProviderRuntimeRegistry({ now: () => 1000 });
    const events: unknown[] = [];
    registry.on('runtime:lifecycle', (event) => events.push(event));

    registry.recordAvailable({
      provider: 'claude',
      runtime: { kind: 'local-cli', command: 'claude' },
      capabilities,
      source: 'adapter-created',
      model: 'claude-opus-4-20250514',
    });

    expect(registry.getSnapshot('claude')).toMatchObject({
      provider: 'claude',
      status: 'available',
      runtime: { kind: 'local-cli', command: 'claude' },
      capabilities,
      model: 'claude-opus-4-20250514',
      lastAvailableAt: 1000,
      lastUpdatedAt: 1000,
      source: 'adapter-created',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'available',
      provider: 'claude',
      previousStatus: 'unknown',
      snapshot: { status: 'available' },
    });
  });

  it('preserves the last shadow report when a later diagnosis is a different misconfiguration', () => {
    const registry = new ProviderRuntimeRegistry({ now: () => 2000 });
    const shadowReport = {
      cli: 'claude' as const,
      activePath: '/usr/local/bin/claude',
      activeVersion: '1.0.0',
      installs: [
        { path: '/usr/local/bin/claude', version: '1.0.0', installed: true },
        { path: '/opt/homebrew/bin/claude', version: '0.9.0', installed: true },
      ],
    };

    registry.applyDiagnosis(diagnosis('claude-cli', 'degraded', [
      probe('cli_installed', 'pass'),
      probe('cli_shadow_check', 'fail', {
        errorKind: 'cli_version_mismatch',
        metadata: { report: shadowReport as unknown as Record<string, unknown> },
      }),
    ]));

    expect(registry.getSnapshot('claude')?.status).toBe('degraded');
    expect(registry.getSnapshot('claude')?.shadowReport).toEqual(shadowReport);

    registry.applyDiagnosis(diagnosis('claude-cli', 'unhealthy', [
      probe('cli_installed', 'fail', { errorKind: 'cli_not_found' }),
      probe('authenticated', 'skip'),
    ]));

    const snapshot = registry.getSnapshot('claude');
    expect(snapshot).toMatchObject({
      provider: 'claude',
      status: 'unavailable',
      shadowReport,
      error: {
        kind: 'cli_not_found',
        message: 'cli_installed fail',
        source: 'doctor',
      },
    });
  });

  it('tracks diagnosis refreshes without erasing prior availability details', () => {
    const registry = new ProviderRuntimeRegistry({ now: () => 3000 });
    registry.recordAvailable({
      provider: 'codex',
      runtime: { kind: 'local-cli', command: 'codex' },
      capabilities,
      source: 'adapter-created',
      model: 'gpt-5.1-codex',
    });

    registry.applyDiagnosis(diagnosis('codex-cli', 'healthy', [
      probe('cli_installed', 'pass'),
      probe('authenticated', 'pass'),
    ]));

    expect(registry.getSnapshot('codex')).toMatchObject({
      status: 'available',
      runtime: { kind: 'local-cli', command: 'codex' },
      capabilities,
      model: 'gpt-5.1-codex',
      diagnosis: {
        provider: 'codex-cli',
        overall: 'healthy',
        failedProbeNames: [],
      },
      lastRefreshedAt: 3000,
    });
  });

  it('returns list snapshots sorted by provider for stable UI consumers', () => {
    const registry = new ProviderRuntimeRegistry({ now: () => 4000 });
    registry.recordUnavailable({
      provider: 'gemini',
      message: 'gemini missing',
      source: 'adapter-create-failed',
    });
    registry.recordAvailable({
      provider: 'claude',
      runtime: { kind: 'local-cli', command: 'claude' },
      source: 'adapter-created',
    });

    expect(registry.listSnapshots().map((snapshot) => snapshot.provider)).toEqual([
      'claude',
      'gemini',
    ]);
  });
});

describe('ProviderRuntimeService registry integration', () => {
  it('records successful adapter creation in the runtime registry', () => {
    const registry = new ProviderRuntimeRegistry({ now: () => 5000 });
    const adapter = {
      interrupt: vi.fn(),
      getRuntimeCapabilities: vi.fn(() => capabilities),
    };
    const createAdapter = vi.fn(() => adapter);
    const service = new ProviderRuntimeService({
      registry,
      createAdapter,
    });

    expect(service.createAdapter({
      cliType: 'claude',
      options: {
        workingDirectory: '/repo',
        model: 'claude-opus-4-20250514',
      },
    })).toBe(adapter);

    expect(createAdapter).toHaveBeenCalledOnce();
    expect(registry.getSnapshot('claude')).toMatchObject({
      status: 'available',
      runtime: {
        kind: 'local-cli',
        cwd: '/repo',
      },
      model: 'claude-opus-4-20250514',
      capabilities,
    });
  });

  it('records adapter creation failure before rethrowing', () => {
    const registry = new ProviderRuntimeRegistry({ now: () => 6000 });
    const createAdapter = vi.fn(() => {
      throw new Error('interactive runtime missing');
    });
    const service = new ProviderRuntimeService({
      registry,
      createAdapter,
    });

    expect(() => service.createAdapter({
      cliType: 'claude',
      options: { launchMode: 'interactive' },
    })).toThrow('interactive runtime missing');

    expect(registry.getSnapshot('claude')).toMatchObject({
      status: 'unavailable',
      error: {
        message: 'interactive runtime missing',
        source: 'adapter-create-failed',
      },
    });
  });
});
