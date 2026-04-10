import { describe, it, expect, beforeEach, vi } from 'vitest';

const { checkClaudeCliAuthentication } = vi.hoisted(() => ({
  checkClaudeCliAuthentication: vi.fn(),
}));

vi.mock('../claude-cli-auth', () => ({
  checkClaudeCliAuthentication,
}));

import { ProviderDoctor } from '../provider-doctor';

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
});
