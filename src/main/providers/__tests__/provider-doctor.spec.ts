import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { checkClaudeCliAuthentication } = vi.hoisted(() => ({
  checkClaudeCliAuthentication: vi.fn(),
}));

vi.mock('../claude-cli-auth', () => ({
  checkClaudeCliAuthentication,
}));

import { CliDetectionService } from '../../cli/cli-detection';
import { ProviderDoctor } from '../provider-doctor';
import { buildRepairActions } from '../provider-doctor-repair';

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

/**
 * Pin the home directory installer ownership is resolved from, so the grok
 * assertions do not depend on the machine running them (a Windows box
 * resolves via USERPROFILE; a CI box may have GROK_HOME set).
 */
function stubGrokHome(): string {
  const home = '/Users/grok-test';
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', '');
  vi.stubEnv('GROK_HOME', '');
  return home;
}

/** A failing grok shadow check: active npm shim 1.0.34 plus these stale copies. */
function grokConflict(home: string, stalePaths: string[]) {
  const active = `${home}/.nvm/versions/node/v24.15.0/bin/grok`;
  const report = {
    installs: [
      { path: active, version: '1.0.34', installed: true },
      ...stalePaths.map((path) => ({ path, version: '1.0.30', installed: true })),
    ],
    activePath: active,
    activeVersion: '1.0.34',
  };
  return {
    name: 'cli_shadow_check',
    status: 'fail' as const,
    message: 'Multiple grok installs with different versions',
    latencyMs: 0,
    metadata: { report: report as unknown as Record<string, unknown> },
  };
}

describe('ProviderDoctor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it('reports a missing CLI as the neutral "not-installed" state, not unhealthy', () => {
    const doctor = ProviderDoctor.getInstance();
    const overall = doctor.aggregateProbeResults([
      { name: 'cli_installed', status: 'fail', message: 'gemini not found in PATH', latencyMs: 0, errorKind: 'cli_not_found' },
      { name: 'cli_shadow_check', status: 'skip', message: 'Skipped (cli_installed failed)', latencyMs: 0 },
      { name: 'authenticated', status: 'skip', message: 'Skipped (cli_installed failed)', latencyMs: 0 },
    ]);
    expect(overall).toBe('not-installed');
  });

  it('keeps overall unhealthy when a missing CLI coincides with another failure', () => {
    const doctor = ProviderDoctor.getInstance();
    const overall = doctor.aggregateProbeResults([
      { name: 'cli_installed', status: 'fail', message: 'gemini not found in PATH', latencyMs: 0, errorKind: 'cli_not_found' },
      { name: 'cli_shadow_check', status: 'fail', message: 'shadow conflict', latencyMs: 0, errorKind: 'cli_shadow_install' },
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

  it('names an installer-maintained mirror instead of counting it as a rival install', async () => {
    // "Single active install" beside a card listing two copies read as a
    // self-contradiction. The mirror is still a pass — same version, nothing
    // can silently win on PATH — but the message has to admit it is there.
    const inspect = vi
      .spyOn(CliDetectionService.getInstance(), 'inspectCliInstalls')
      .mockResolvedValue({
        installs: [
          { path: '/Users/test/.nvm/versions/node/v24.15.0/bin/grok', version: '1.0.34', installed: true },
          {
            path: '/Users/test/.grok/bin/grok',
            version: '1.0.34',
            installed: true,
            installerCopy: true,
          },
        ],
        shadow: null,
      });

    const shadowProbe = ProviderDoctor.getInstance()
      .getProbesForProvider('grok')
      .find((probe) => probe.name === 'cli_shadow_check');

    expect(shadowProbe).toBeDefined();

    const result = await shadowProbe!.run('grok');

    expect(result).toMatchObject({
      name: 'cli_shadow_check',
      status: 'pass',
      message: 'Single active install (no shadows detected) '
        + '(+1 installer-maintained copy of the same install)',
    });

    inspect.mockRestore();
  });

  it('states the real copy count when separate installs agree on version', async () => {
    const inspect = vi
      .spyOn(CliDetectionService.getInstance(), 'inspectCliInstalls')
      .mockResolvedValue({
        installs: [
          { path: '/Users/test/.nvm/versions/node/v24.15.0/bin/codex', version: '0.155.1', installed: true },
          { path: '/opt/homebrew/bin/codex', version: '0.155.1', installed: true },
        ],
        shadow: null,
      });

    const shadowProbe = ProviderDoctor.getInstance()
      .getProbesForProvider('codex-cli')
      .find((probe) => probe.name === 'cli_shadow_check');

    const result = await shadowProbe!.run('codex-cli');

    expect(result).toMatchObject({
      status: 'pass',
      message: '2 copies on PATH, all reporting v0.155.1 (no version conflict)',
    });

    inspect.mockRestore();
  });

  it('keeps the single-install wording when only one copy is on PATH', async () => {
    const inspect = vi
      .spyOn(CliDetectionService.getInstance(), 'inspectCliInstalls')
      .mockResolvedValue({
        installs: [{ path: '/Users/test/.grok/bin/grok', version: '1.0.34', installed: true }],
        shadow: null,
      });

    const shadowProbe = ProviderDoctor.getInstance()
      .getProbesForProvider('grok')
      .find((probe) => probe.name === 'cli_shadow_check');

    const result = await shadowProbe!.run('grok');

    expect(result).toMatchObject({
      status: 'pass',
      message: 'Single active install (no shadows detected)',
    });

    inspect.mockRestore();
  });

  it('does not claim copies agree when a version could not be read', async () => {
    const inspect = vi
      .spyOn(CliDetectionService.getInstance(), 'inspectCliInstalls')
      .mockResolvedValue({
        installs: [
          { path: '/Users/test/.nvm/versions/node/v24.15.0/bin/codex', version: '0.155.1', installed: true },
          { path: '/usr/local/bin/codex', installed: true, error: 'Timeout checking CLI' },
        ],
        shadow: null,
      });

    const shadowProbe = ProviderDoctor.getInstance()
      .getProbesForProvider('codex-cli')
      .find((probe) => probe.name === 'cli_shadow_check');

    const result = await shadowProbe!.run('codex-cli');

    expect(result).toMatchObject({
      status: 'pass',
      message: '2 copies on PATH, v0.155.1 where readable'
        + ' (no conflict among the versions that could be read)',
    });

    inspect.mockRestore();
  });

  it('says so plainly when no copy reported a readable version', async () => {
    const inspect = vi
      .spyOn(CliDetectionService.getInstance(), 'inspectCliInstalls')
      .mockResolvedValue({
        installs: [
          { path: '/Users/test/.nvm/versions/node/v24.15.0/bin/codex', installed: true },
          { path: '/usr/local/bin/codex', installed: true },
        ],
        shadow: null,
      });

    const shadowProbe = ProviderDoctor.getInstance()
      .getProbesForProvider('codex-cli')
      .find((probe) => probe.name === 'cli_shadow_check');

    const result = await shadowProbe!.run('codex-cli');

    expect(result).toMatchObject({
      status: 'pass',
      message: '2 copies on PATH, none reporting a readable version',
    });

    inspect.mockRestore();
  });

  it('accounts for installer copies in the conflict message too', async () => {
    // A failing message that lists fewer copies than the card shows is the
    // same contradiction as the original bug, just on the unhappy path.
    const separate = [
      { path: '/Users/test/.nvm/versions/node/v24.15.0/bin/grok', version: '1.0.34', installed: true },
      { path: '/opt/homebrew/bin/grok', version: '1.0.30', installed: true },
    ];
    const inspect = vi
      .spyOn(CliDetectionService.getInstance(), 'inspectCliInstalls')
      .mockResolvedValue({
        installs: [
          ...separate,
          { path: '/Users/test/.grok/bin/grok', version: '1.0.34', installed: true, installerCopy: true },
        ],
        shadow: {
          cli: 'grok',
          installs: separate,
          activePath: separate[0].path,
          activeVersion: '1.0.34',
        },
      });

    const shadowProbe = ProviderDoctor.getInstance()
      .getProbesForProvider('grok')
      .find((probe) => probe.name === 'cli_shadow_check');

    const result = await shadowProbe!.run('grok');

    expect(result.status).toBe('fail');
    expect(result.message).toContain('(+1 installer-maintained copy of the same install)');
    expect(result.message).toContain('/opt/homebrew/bin/grok (v1.0.30)');

    inspect.mockRestore();
  });

  it('classifies a shadow report as a version mismatch, never the vaguer kind', async () => {
    // buildShadowReport only emits a report for copies with readable,
    // differing versions, so the old "same version ⇒ cli_shadow_install"
    // branch could only mislabel a real mismatch.
    const installs = [
      { path: '/Users/test/.nvm/versions/node/v24.15.0/bin/codex', version: '0.155.1', installed: true },
      { path: '/opt/homebrew/bin/codex', version: '0.140.0', installed: true },
    ];
    const inspect = vi
      .spyOn(CliDetectionService.getInstance(), 'inspectCliInstalls')
      .mockResolvedValue({
        installs,
        shadow: {
          cli: 'codex',
          installs,
          activePath: installs[0].path,
          activeVersion: installs[0].version,
        },
      });

    const shadowProbe = ProviderDoctor.getInstance()
      .getProbesForProvider('codex-cli')
      .find((probe) => probe.name === 'cli_shadow_check');

    const result = await shadowProbe!.run('codex-cli');

    expect(result.status).toBe('fail');
    expect(result.errorKind).toBe('cli_version_mismatch');

    inspect.mockRestore();
  });

  it('gives grok the same install command in recommendations and repair actions', () => {
    // One canonical instruction per provider: the two used to disagree (npm in
    // the repair action, the download page in the recommendation).
    const probe = {
      name: 'cli_installed',
      status: 'fail' as const,
      message: 'grok not found in PATH',
      latencyMs: 0,
      errorKind: 'cli_not_found' as const,
    };
    const doctor = ProviderDoctor.getInstance();
    const recommendation = doctor.generateRecommendations('grok', [probe])[0] ?? '';
    const action = buildRepairActions({ provider: 'grok', probes: [probe] })[0];

    expect(recommendation).toContain('npm install -g @xai-official/grok');
    expect(action?.command).toContain('npm install -g @xai-official/grok');
  });

  it('tells grok users to reinstall rather than delete an installer-owned copy', () => {
    // CLI Health renders recommendations only (no repair actions), so this
    // string is the entire guidance shown there — it must not contradict the
    // help text by telling the user to delete the ~/.grok/bin copy that grok's
    // own postinstall recreates.
    const home = stubGrokHome();
    const recs = ProviderDoctor.getInstance().generateRecommendations('grok', [
      grokConflict(home, [`${home}/.grok/bin/grok`]),
    ]);

    expect(recs).toHaveLength(1);
    expect(recs[0]).toContain('Reinstall grok to refresh the copies its installer maintains');
    expect(recs[0]).toContain(`${home}/.grok/bin/grok`);
    expect(recs[0]).not.toContain('Remove the stale copies');
  });

  it('advises removing an abandoned ~/.grok/bin once GROK_HOME points elsewhere', () => {
    // With GROK_HOME set, grok's installer only ever writes $GROK_HOME/bin, so a
    // reinstall never refreshes ~/.grok/bin — "do not delete" would leave the
    // conflict in place for good.
    const home = stubGrokHome();
    vi.stubEnv('GROK_HOME', '/opt/grok-home');
    const [rec] = ProviderDoctor.getInstance().generateRecommendations('grok', [
      grokConflict(home, [`${home}/.grok/bin/grok`]),
    ]);

    expect(rec).toContain('Remove the stale copies');
    expect(rec).toContain(`${home}/.grok/bin/grok`);
    expect(rec).not.toContain('do not delete');
  });

  it('splits grok advice per copy: reinstall for its own, remove for leftovers', () => {
    // A stale grok under another node version or Homebrew is not refreshed by
    // the reinstall; telling the user not to delete it would forbid the only
    // fix and leave the conflict in place.
    const home = stubGrokHome();
    const leftover = `${home}/.nvm/versions/node/v22.22.2/bin/grok`;
    const [rec] = ProviderDoctor.getInstance().generateRecommendations('grok', [
      grokConflict(home, [`${home}/.grok/bin/grok`, leftover]),
    ]);

    expect(rec).toContain('Remove the stale copies');
    expect(rec).toContain(leftover);
    expect(rec).toContain('Reinstall grok to refresh the copies its installer maintains');
    // The leftover must not appear under the "do not delete" heading.
    const reinstallBlock = rec?.slice(rec.indexOf('Reinstall grok')) ?? '';
    expect(reinstallBlock).not.toContain(leftover);
  });

  it('still recommends removing stale copies for a CLI with no installer-owned copy', () => {
    const doctor = ProviderDoctor.getInstance();
    const report = {
      installs: [
        { path: '/Users/test/.nvm/versions/node/v24.15.0/bin/codex', version: '0.155.1', installed: true },
        { path: '/opt/homebrew/bin/codex', version: '0.140.0', installed: true },
      ],
      activePath: '/Users/test/.nvm/versions/node/v24.15.0/bin/codex',
      activeVersion: '0.155.1',
    };
    const recs = doctor.generateRecommendations('codex-cli', [
      {
        name: 'cli_shadow_check',
        status: 'fail',
        message: 'Multiple codex installs with different versions',
        latencyMs: 0,
        metadata: { report: report as unknown as Record<string, unknown> },
      },
    ]);

    expect(recs[0]).toContain('Remove the stale copies');
  });

  it('recommends the direct Copilot CLI install path', () => {
    const doctor = ProviderDoctor.getInstance();
    const recs = doctor.generateRecommendations('copilot', [
      { name: 'cli_installed', status: 'fail', message: 'copilot not found in PATH', latencyMs: 0 },
    ]);

    expect(recs[0]).toContain('@github/copilot');
  });
});
