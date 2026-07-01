/**
 * Tests for ProviderDoctor: classifyProbeFailure, buildRepairActions, errorKind
 * population, and the zero-actions case for a passing diagnosis.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderDoctor,
  classifyProbeFailure,
  buildRepairActions,
  buildRuntimeLogBundle,
} from './provider-doctor';
import type { ProbeResult, DiagnosisResult } from './provider-doctor';
import type { ProviderProbeErrorKind } from '../../shared/types/provider-doctor.types';
import { _resetProviderRuntimeRegistryForTesting, getProviderRuntimeRegistry } from './provider-runtime-registry';

const { checkProviderStatus } = vi.hoisted(() => ({
  checkProviderStatus: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module-level mocks for all external dependencies the probes touch at import
// time or runtime.
// ---------------------------------------------------------------------------

vi.mock('./claude-cli-auth', () => ({
  checkClaudeCliAuthentication: vi.fn().mockResolvedValue({ authenticated: false, message: 'not authenticated' }),
}));
vi.mock('./codex-cli-auth', () => ({
  checkCodexCliAuthentication: vi.fn().mockResolvedValue({ authenticated: false, message: 'not authenticated' }),
}));
vi.mock('./gemini-cli-auth', () => ({
  checkGeminiCliAuthentication: vi.fn().mockResolvedValue({ authenticated: false, message: 'not authenticated' }),
}));
vi.mock('../cli/copilot-cli-launch', () => ({
  resolveCopilotCliLaunch: vi.fn().mockReturnValue(null),
}));
vi.mock('../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: vi.fn().mockReturnValue({
      detectShadowInstalls: vi.fn().mockResolvedValue(null),
    }),
  },
}));
vi.mock('../cli/cli-environment', () => ({
  buildCliSpawnOptions: vi.fn().mockReturnValue({}),
}));
vi.mock('../logging/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('./provider-instance-manager', () => ({
  getProviderInstanceManager: vi.fn().mockReturnValue({
    checkProviderStatus,
  }),
}));
// child_process is used by the cli_installed probe internally; provide a
// partial mock that forwards everything else through the real module.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn().mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: (e: null, out: string, err: string) => void) => {
        cb(null, '/usr/local/bin/mock-cli', '');
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeProbe(
  name: string,
  status: ProbeResult['status'],
  overrides: Partial<ProbeResult> = {},
): ProbeResult {
  return {
    name,
    status,
    message: overrides.message ?? `${name} ${status}`,
    latencyMs: 0,
    ...overrides,
  };
}

function makeDiagnosis(
  provider: string,
  probes: ProbeResult[],
): DiagnosisResult {
  return {
    provider,
    probes,
    overall: 'healthy',
    recommendations: [],
    repairActions: [],
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// classifyProbeFailure
// ---------------------------------------------------------------------------

describe('classifyProbeFailure', () => {
  it('returns cli_not_found for cli_installed probe', () => {
    const probe = makeProbe('cli_installed', 'fail', { message: 'claude not found in PATH' });
    expect(classifyProbeFailure(probe)).toBe<ProviderProbeErrorKind>('cli_not_found');
  });

  it('returns cli_shadow_install for shadow check with same versions', () => {
    const report = {
      installs: [
        { path: '/usr/local/bin/claude', version: '1.0.0', installed: true },
        { path: '/opt/homebrew/bin/claude', version: '1.0.0', installed: true },
      ],
      activePath: '/usr/local/bin/claude',
      activeVersion: '1.0.0',
    };
    const probe = makeProbe('cli_shadow_check', 'fail', {
      metadata: { report: report as unknown as Record<string, unknown> },
    });
    expect(classifyProbeFailure(probe)).toBe<ProviderProbeErrorKind>('cli_shadow_install');
  });

  it('returns cli_version_mismatch for shadow check with differing versions', () => {
    const report = {
      installs: [
        { path: '/usr/local/bin/claude', version: '1.0.0', installed: true },
        { path: '/opt/homebrew/bin/claude', version: '2.0.0', installed: true },
      ],
      activePath: '/usr/local/bin/claude',
      activeVersion: '1.0.0',
    };
    const probe = makeProbe('cli_shadow_check', 'fail', {
      metadata: { report: report as unknown as Record<string, unknown> },
    });
    expect(classifyProbeFailure(probe)).toBe<ProviderProbeErrorKind>('cli_version_mismatch');
  });

  it('returns cli_shadow_install for shadow check with no report metadata', () => {
    const probe = makeProbe('cli_shadow_check', 'fail');
    expect(classifyProbeFailure(probe)).toBe<ProviderProbeErrorKind>('cli_shadow_install');
  });

  it('returns auth_missing for authenticated probe with generic message', () => {
    const probe = makeProbe('authenticated', 'fail', { message: 'ANTHROPIC_API_KEY not found' });
    expect(classifyProbeFailure(probe)).toBe<ProviderProbeErrorKind>('auth_missing');
  });

  it('returns auth_expired for authenticated probe with expired in message', () => {
    const probe = makeProbe('authenticated', 'fail', { message: 'token expired, please re-authenticate' });
    expect(classifyProbeFailure(probe)).toBe<ProviderProbeErrorKind>('auth_expired');
  });

  it('returns auth_expired for authenticated probe with invalid in message', () => {
    const probe = makeProbe('authenticated', 'fail', { message: 'invalid credentials' });
    expect(classifyProbeFailure(probe)).toBe<ProviderProbeErrorKind>('auth_expired');
  });

  it('returns auth_expired for authenticated probe with revoked in message', () => {
    const probe = makeProbe('authenticated', 'fail', { message: 'token has been revoked' });
    expect(classifyProbeFailure(probe)).toBe<ProviderProbeErrorKind>('auth_expired');
  });

  it('returns endpoint_unreachable for reachable probe', () => {
    const probe = makeProbe('reachable', 'fail', { message: 'API endpoint unreachable' });
    expect(classifyProbeFailure(probe)).toBe<ProviderProbeErrorKind>('endpoint_unreachable');
  });

  it('returns unknown for an unrecognised probe name', () => {
    const probe = makeProbe('some_future_probe', 'fail');
    expect(classifyProbeFailure(probe)).toBe<ProviderProbeErrorKind>('unknown');
  });
});

// ---------------------------------------------------------------------------
// buildRepairActions
// ---------------------------------------------------------------------------

describe('buildRepairActions', () => {
  it('returns zero actions when all probes pass', () => {
    const diagnosis = makeDiagnosis('claude-cli', [
      makeProbe('cli_installed', 'pass'),
      makeProbe('cli_shadow_check', 'pass'),
      makeProbe('authenticated', 'pass'),
    ]);
    expect(buildRepairActions(diagnosis)).toHaveLength(0);
  });

  it('returns zero actions when all probes are skipped', () => {
    const diagnosis = makeDiagnosis('cursor', [
      makeProbe('authenticated', 'skip'),
    ]);
    expect(buildRepairActions(diagnosis)).toHaveLength(0);
  });

  it('returns a critical install action for cli_not_found', () => {
    const probe = makeProbe('cli_installed', 'fail', {
      errorKind: 'cli_not_found',
    });
    const diagnosis = makeDiagnosis('claude-cli', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('cli_not_found');
    expect(actions[0].severity).toBe('critical');
    expect(actions[0].command).toContain('npm install -g @anthropic-ai/claude-code');
    // Must not contain secrets
    expect(actions[0].command).not.toMatch(/\bsk-/);
    expect(actions[0].command).not.toMatch(/\bANTHROPIC_API_KEY\b/);
  });

  it('returns an install action with correct package for codex-cli', () => {
    const probe = makeProbe('cli_installed', 'fail', { errorKind: 'cli_not_found' });
    const diagnosis = makeDiagnosis('codex-cli', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions[0].command).toContain('@openai/codex');
  });

  it('returns an install action with correct package for gemini-cli', () => {
    const probe = makeProbe('cli_installed', 'fail', { errorKind: 'cli_not_found' });
    const diagnosis = makeDiagnosis('gemini-cli', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions[0].command).toContain('@google/gemini-cli');
  });

  it('returns a warning action for cli_shadow_install', () => {
    const report = {
      installs: [
        { path: '/usr/local/bin/claude', version: '1.0.0', installed: true },
        { path: '/opt/homebrew/bin/claude', version: '1.0.0', installed: true },
      ],
      activePath: '/usr/local/bin/claude',
      activeVersion: '1.0.0',
    };
    const probe = makeProbe('cli_shadow_check', 'fail', {
      errorKind: 'cli_shadow_install',
      metadata: { report: report as unknown as Record<string, unknown> },
    });
    const diagnosis = makeDiagnosis('claude-cli', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('cli_shadow_install');
    expect(actions[0].severity).toBe('warning');
  });

  it('returns a warning action for cli_version_mismatch', () => {
    const probe = makeProbe('cli_shadow_check', 'fail', { errorKind: 'cli_version_mismatch' });
    const diagnosis = makeDiagnosis('claude-cli', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions[0].kind).toBe('cli_version_mismatch');
    expect(actions[0].severity).toBe('warning');
    // Must include the install command so the user knows how to update
    expect(actions[0].command).toContain('npm install');
  });

  it('returns a critical action for auth_missing', () => {
    const probe = makeProbe('authenticated', 'fail', { errorKind: 'auth_missing' });
    const diagnosis = makeDiagnosis('claude-cli', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions[0].kind).toBe('auth_missing');
    expect(actions[0].severity).toBe('critical');
    expect(actions[0].command).toContain('claude auth login');
  });

  it('returns auth_missing action for codex-cli pointing to codex login', () => {
    const probe = makeProbe('authenticated', 'fail', { errorKind: 'auth_missing' });
    const diagnosis = makeDiagnosis('codex-cli', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions[0].command).toContain('codex login');
  });

  it('returns a critical action for auth_expired', () => {
    const probe = makeProbe('authenticated', 'fail', { errorKind: 'auth_expired' });
    const diagnosis = makeDiagnosis('gemini-cli', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions[0].kind).toBe('auth_expired');
    expect(actions[0].severity).toBe('critical');
  });

  it('returns a warning action for endpoint_unreachable with curl preview', () => {
    const probe = makeProbe('reachable', 'fail', { errorKind: 'endpoint_unreachable' });
    const diagnosis = makeDiagnosis('anthropic-api', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions[0].kind).toBe('endpoint_unreachable');
    expect(actions[0].severity).toBe('warning');
    expect(actions[0].command).toContain('curl');
    expect(actions[0].command).not.toContain('sk-');
  });

  it('returns an info action for unknown kind', () => {
    const probe = makeProbe('some_future_probe', 'fail', { errorKind: 'unknown' });
    const diagnosis = makeDiagnosis('claude-cli', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions[0].kind).toBe('unknown');
    expect(actions[0].severity).toBe('info');
  });

  it('falls back to classifyProbeFailure when errorKind is absent on a failed probe', () => {
    // No errorKind set — buildRepairActions should classify it internally.
    const probe = makeProbe('cli_installed', 'fail', { message: 'gemini not found in PATH' });
    const diagnosis = makeDiagnosis('gemini-cli', [probe]);
    const actions = buildRepairActions(diagnosis);
    expect(actions[0].kind).toBe('cli_not_found');
  });

  it('produces one action per failed probe', () => {
    const diagnosis = makeDiagnosis('claude-cli', [
      makeProbe('cli_installed', 'fail', { errorKind: 'cli_not_found' }),
      makeProbe('authenticated', 'fail', { errorKind: 'auth_missing' }),
    ]);
    expect(buildRepairActions(diagnosis)).toHaveLength(2);
  });

  it('command previews contain no secret-shaped tokens', () => {
    const kinds: ProviderProbeErrorKind[] = [
      'cli_not_found', 'cli_shadow_install', 'cli_version_mismatch',
      'auth_missing', 'auth_expired', 'endpoint_unreachable', 'unknown',
    ];
    for (const kind of kinds) {
      const probe = makeProbe('cli_installed', 'fail', { errorKind: kind });
      const diagnosis = makeDiagnosis('claude-cli', [probe]);
      const actions = buildRepairActions(diagnosis);
      for (const action of actions) {
        // Must not look like an API key or access token
        expect(action.command).not.toMatch(/\bsk-[A-Za-z0-9]{20,}/);
        expect(action.command).not.toMatch(/ghp_[A-Za-z0-9]{36}/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// errorKind population in real probe results
// ---------------------------------------------------------------------------

describe('ProviderDoctor probe errorKind population', () => {
  beforeEach(() => {
    ProviderDoctor._resetForTesting();
    _resetProviderRuntimeRegistryForTesting();
    checkProviderStatus.mockReset();
  });

  it('populated errorKind is absent on a passing probe result', async () => {
    // The cli_shadow_check probe returns pass when no shadow report exists —
    // which is the default mock (detectShadowInstalls returns null).
    const doctor = ProviderDoctor.getInstance();
    // Run only the shadow check probe in isolation for speed.
    const probe = doctor.getProbesForProvider('claude-cli').find(p => p.name === 'cli_shadow_check');
    expect(probe).toBeDefined();
    const result = await probe!.run('claude-cli');
    expect(result.status).toBe('pass');
    expect(result.errorKind).toBeUndefined();
  });

  it('buildRepairActions returns zero actions when all probes are passing — pure unit check', () => {
    // Verify the invariant at the pure-function level without needing live I/O.
    const diagnosis = makeDiagnosis('claude-cli', [
      makeProbe('cli_installed', 'pass'),
      makeProbe('cli_shadow_check', 'pass'),
      makeProbe('authenticated', 'pass'),
    ]);
    expect(buildRepairActions(diagnosis)).toHaveLength(0);
  });

  it('full diagnose() call populates repairActions on DiagnosisResult', async () => {
    // The top-level mock makes execFile succeed (cli_installed passes),
    // detectShadowInstalls returns null (shadow passes), and auth returns false.
    // So we expect exactly one repair action for the auth_missing probe.
    ProviderDoctor._resetForTesting();
    const doctor = ProviderDoctor.getInstance();
    const diagnosis = await doctor.diagnose('claude-cli');
    // repairActions must always be an array (never undefined)
    expect(Array.isArray(diagnosis.repairActions)).toBe(true);
    // With auth failing, at least one action should be present
    const authFail = diagnosis.probes.find(p => p.name === 'authenticated' && p.status === 'fail');
    if (authFail) {
      expect(diagnosis.repairActions.length).toBeGreaterThan(0);
      const authAction = diagnosis.repairActions.find(a => a.kind === 'auth_missing' || a.kind === 'auth_expired');
      expect(authAction).toBeDefined();
    }
  });

  it('failed probe has errorKind set in the diagnosis probes array', async () => {
    // anthropic-api has the reachable probe which will fail in this env
    // because no real network calls are made in tests. We use fetch mock.
    // Use vi.stubGlobal (not a raw `global.fetch =` assignment) so the shared
    // test-setup `vi.unstubAllGlobals()` restores the real fetch afterwards.
    // A raw assignment leaks a one-shot mock (which returns undefined after its
    // single mockRejectedValueOnce) into every later spec in the same vitest
    // worker, breaking unrelated fetch-using tests (http-transport, clipboard…).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network error')));

    ProviderDoctor._resetForTesting();
    const doctor = ProviderDoctor.getInstance();
    const probe = doctor.getProbesForProvider('anthropic-api').find(p => p.name === 'reachable');
    expect(probe).toBeDefined();
    const result = await probe!.run('anthropic-api');
    expect(result.status).toBe('fail');
    expect(result.errorKind).toBe('endpoint_unreachable');
  });

  it('diagnoses plugin providers through the provider instance manager status path', async () => {
    checkProviderStatus.mockResolvedValueOnce({
      type: 'plugin:acme-cli',
      available: false,
      authenticated: false,
      error: 'worker factory failed health check',
    });

    const doctor = ProviderDoctor.getInstance();
    const diagnosis = await doctor.diagnose('plugin:acme-cli');

    expect(checkProviderStatus).toHaveBeenCalledWith('plugin:acme-cli', true);
    expect(diagnosis.provider).toBe('plugin:acme-cli');
    expect(diagnosis.overall).toBe('unhealthy');
    expect(diagnosis.probes).toEqual([
      expect.objectContaining({
        name: 'plugin_provider_status',
        status: 'fail',
        message: 'worker factory failed health check',
        errorKind: 'unknown',
      }),
    ]);
    expect(getProviderRuntimeRegistry().getSnapshot('plugin:acme-cli' as never))
      .toMatchObject({
        provider: 'plugin:acme-cli',
        status: 'unavailable',
        diagnosis: {
          provider: 'plugin:acme-cli',
          failedProbeNames: ['plugin_provider_status'],
        },
      });
  });

  it('redacts secret-shaped plugin provider status errors before surfacing diagnosis output', async () => {
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    checkProviderStatus.mockResolvedValueOnce({
      type: 'plugin:acme-cli',
      available: false,
      authenticated: false,
      error: `plugin rejected api key ${secret}`,
    });

    const doctor = ProviderDoctor.getInstance();
    const diagnosis = await doctor.diagnose('plugin:acme-cli');

    expect(diagnosis.probes[0].message).not.toContain(secret);
    expect(diagnosis.probes[0].message).toContain('<redacted-secret>');
    expect(diagnosis.recommendations.join('\n')).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// buildRuntimeLogBundle — B4 redacted runtime-log bundles
// ---------------------------------------------------------------------------

describe('buildRuntimeLogBundle', () => {
  it('returns undefined when all probes pass', () => {
    const probes = [
      makeProbe('cli_installed', 'pass'),
      makeProbe('authenticated', 'pass'),
    ];
    expect(buildRuntimeLogBundle(probes)).toBeUndefined();
  });

  it('returns undefined when all probes are skipped', () => {
    expect(buildRuntimeLogBundle([makeProbe('authenticated', 'skip')])).toBeUndefined();
  });

  it('includes failed probe messages in entries', () => {
    const probes = [
      makeProbe('cli_installed', 'fail', { message: 'claude not found in PATH' }),
      makeProbe('authenticated', 'pass'),
    ];
    const bundle = buildRuntimeLogBundle(probes);
    expect(bundle).toBeDefined();
    expect(bundle!.entries).toHaveLength(1);
    expect(bundle!.entries[0]).toContain('cli_installed');
    expect(bundle!.entries[0]).toContain('claude not found in PATH');
  });

  it('includes timeout probes in entries', () => {
    const probes = [makeProbe('reachable', 'timeout', { message: 'probe timed out' })];
    const bundle = buildRuntimeLogBundle(probes);
    expect(bundle).toBeDefined();
    expect(bundle!.entries[0]).toContain('reachable');
    expect(bundle!.entries[0]).toContain('probe timed out');
  });

  it('redacts Anthropic-style API keys', () => {
    const key = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const probes = [makeProbe('authenticated', 'fail', { message: `API key ${key} is invalid` })];
    const bundle = buildRuntimeLogBundle(probes)!;
    expect(bundle.entries[0]).not.toContain(key);
    expect(bundle.entries[0]).toContain('[REDACTED]');
    expect(bundle.redactedCount).toBeGreaterThan(0);
  });

  it('redacts bearer tokens', () => {
    const probes = [
      makeProbe('authenticated', 'fail', { message: 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.signature' }),
    ];
    const bundle = buildRuntimeLogBundle(probes)!;
    expect(bundle.entries[0]).not.toContain('eyJhbGciOiJSUzI1NiJ9.payload.signature');
    expect(bundle.entries[0]).toContain('[REDACTED]');
  });

  it('leaves non-secret content intact', () => {
    const probes = [makeProbe('cli_installed', 'fail', { message: 'claude not found in PATH /usr/bin' })];
    const bundle = buildRuntimeLogBundle(probes)!;
    expect(bundle.entries[0]).toContain('not found in PATH');
    expect(bundle.redactedCount).toBe(0);
  });

  it('collects entries from all failed probes', () => {
    const probes = [
      makeProbe('cli_installed', 'fail'),
      makeProbe('authenticated', 'fail'),
      makeProbe('cli_shadow_check', 'pass'),
    ];
    const bundle = buildRuntimeLogBundle(probes)!;
    expect(bundle.entries).toHaveLength(2);
  });

  it('diagnose() attaches logBundle when probes fail', async () => {
    ProviderDoctor._resetForTesting();
    const doctor = ProviderDoctor.getInstance();
    const diagnosis = await doctor.diagnose('claude-cli');
    const hasFailed = diagnosis.probes.some(p => p.status === 'fail' || p.status === 'timeout');
    if (hasFailed) {
      expect(diagnosis.logBundle).toBeDefined();
      expect(Array.isArray(diagnosis.logBundle!.entries)).toBe(true);
      expect(diagnosis.logBundle!.entries.length).toBeGreaterThan(0);
    } else {
      expect(diagnosis.logBundle).toBeUndefined();
    }
  });
});
