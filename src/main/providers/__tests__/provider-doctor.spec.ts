import { describe, it, expect, beforeEach, vi } from 'vitest';

const { checkClaudeCliAuthentication } = vi.hoisted(() => ({
  checkClaudeCliAuthentication: vi.fn(),
}));

vi.mock('../claude-cli-auth', () => ({
  checkClaudeCliAuthentication,
}));

import { ProviderDoctor } from '../provider-doctor';

async function withPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T> | T,
): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, 'platform', originalDescriptor);
    }
  }
}

describe('ProviderDoctor', () => {
  beforeEach(() => {
    ProviderDoctor._resetForTesting();
    checkClaudeCliAuthentication.mockReset();
  });

  it('should be a singleton', () => {
    const a = ProviderDoctor.getInstance();
    const b = ProviderDoctor.getInstance();
    expect(a).toBe(b);
  });

  it('should return probe definitions for a provider', () => {
    const doctor = ProviderDoctor.getInstance();
    const probes = doctor.getProbesForProvider('claude-cli');
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.map(p => p.name)).toContain('cli_installed');
    expect(probes.map(p => p.name)).toContain('authenticated');
  });

  it('tracks cursor as CLI install and shadow-check probes', () => {
    const doctor = ProviderDoctor.getInstance();
    const probes = doctor.getProbesForProvider('cursor');
    expect(probes.map((probe) => probe.name)).toEqual(['cli_installed', 'cli_shadow_check']);
  });

  it('uses the Windows path resolver for CLI install checks', async () => {
    const doctor = ProviderDoctor.getInstance();
    const execFileAsync = vi
      .spyOn(
        doctor as unknown as {
          execFileAsync: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
        },
        'execFileAsync',
      )
      .mockResolvedValue({
        stdout: 'C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd\r\n',
        stderr: '',
      });

    const cliProbe = doctor
      .getProbesForProvider('claude-cli')
      .find((probe) => probe.name === 'cli_installed');

    expect(cliProbe).toBeDefined();

    const result = await withPlatform('win32', () => cliProbe!.run('claude-cli'));

    expect(execFileAsync).toHaveBeenCalledWith('where', ['claude']);
    expect(result).toMatchObject({
      name: 'cli_installed',
      status: 'pass',
      message: 'claude found in PATH',
    });

    execFileAsync.mockRestore();
  });

  it('should aggregate healthy results correctly', () => {
    const doctor = ProviderDoctor.getInstance();
    const overall = doctor.aggregateProbeResults([
      { name: 'cli_installed', status: 'pass', message: 'Found', latencyMs: 50 },
      { name: 'authenticated', status: 'pass', message: 'OK', latencyMs: 120 },
    ]);
    expect(overall).toBe('healthy');
  });

  it('should mark overall as degraded when non-critical probe fails', () => {
    const doctor = ProviderDoctor.getInstance();
    const overall = doctor.aggregateProbeResults([
      { name: 'cli_installed', status: 'pass', message: 'Found', latencyMs: 50 },
      { name: 'authenticated', status: 'fail', message: 'No key', latencyMs: 0 },
    ]);
    expect(overall).toBe('degraded');
  });

  it('should mark overall as unhealthy when critical probe fails', () => {
    const doctor = ProviderDoctor.getInstance();
    const overall = doctor.aggregateProbeResults([
      { name: 'cli_installed', status: 'fail', message: 'Not found', latencyMs: 0 },
    ]);
    expect(overall).toBe('unhealthy');
  });

  it('should generate recommendations from failed probes', () => {
    const doctor = ProviderDoctor.getInstance();
    const recs = doctor.generateRecommendations('claude-cli', [
      { name: 'cli_installed', status: 'fail', message: 'Not found', latencyMs: 0 },
    ]);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].toLowerCase()).toContain('install');
  });

  it('uses Claude CLI auth status instead of environment variables', async () => {
    checkClaudeCliAuthentication.mockResolvedValue({
      authenticated: true,
      message: 'Claude CLI authenticated via claude.ai (max)',
      metadata: { authMethod: 'claude.ai', subscriptionType: 'max' },
    });

    const doctor = ProviderDoctor.getInstance();
    const authProbe = doctor.getProbesForProvider('claude-cli').find((probe) => probe.name === 'authenticated');

    expect(authProbe).toBeDefined();

    const result = await authProbe!.run('claude-cli');
    expect(checkClaudeCliAuthentication).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      name: 'authenticated',
      status: 'pass',
      message: 'Claude CLI authenticated via claude.ai (max)',
      metadata: { authMethod: 'claude.ai', subscriptionType: 'max' },
    });
  });

  it('recommends Claude auth login and doctor when Claude CLI auth is missing', () => {
    const doctor = ProviderDoctor.getInstance();
    const recs = doctor.generateRecommendations('claude-cli', [
      { name: 'authenticated', status: 'fail', message: 'Claude CLI is not logged in', latencyMs: 0 },
    ]);

    expect(recs).toHaveLength(1);
    expect(recs[0]).toContain('claude auth login');
    expect(recs[0]).toContain('claude doctor');
  });

  it('recommends the direct Copilot CLI install path', () => {
    const doctor = ProviderDoctor.getInstance();
    const recs = doctor.generateRecommendations('copilot', [
      { name: 'cli_installed', status: 'fail', message: 'copilot not found in PATH', latencyMs: 0 },
    ]);

    expect(recs[0]).toContain('@github/copilot');
  });
});
