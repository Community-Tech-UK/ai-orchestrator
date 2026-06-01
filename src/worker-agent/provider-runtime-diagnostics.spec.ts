import { describe, expect, it } from 'vitest';
import { diagnoseProviderRuntime, type ProviderDiagnosticExec } from './provider-runtime-diagnostics';

function makeExec(results: Record<string, { stdout?: string; stderr?: string; error?: Error }>): ProviderDiagnosticExec {
  return async (file, args) => {
    const key = [file, ...args].join(' ');
    const result = results[key];
    if (!result) {
      throw new Error(`unexpected command: ${key}`);
    }
    if (result.error) {
      throw Object.assign(result.error, {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      });
    }
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

describe('diagnoseProviderRuntime', () => {
  it('reports Copilot authentication failure from the worker service identity', async () => {
    const result = await diagnoseProviderRuntime('copilot', {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Windows\\ServiceProfiles\\ai-orchestrator-worker',
      },
      exec: makeExec({
        'whoami': { stdout: 'nt service\\ai-orchestrator-worker\r\n' },
        'copilot --version': { stdout: 'GitHub Copilot CLI 1.0.56\r\n' },
        'copilot -p say ok --allow-all-tools --no-auto-update --log-level none --output-format json --stream off': {
          stderr: 'Authentication required',
          error: new Error('exit 1'),
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.identity.username).toBe('nt service\\ai-orchestrator-worker');
    expect(result.identity.serviceAccountLikely).toBe(true);
    expect(result.provider.available).toBe(true);
    expect(result.provider.authenticated).toBe(false);
    expect(result.provider.remediation).toContain('Run the worker provider runner as your Windows user');
  });

  it('reports Copilot authenticated when the worker-context probe succeeds', async () => {
    const result = await diagnoseProviderRuntime('copilot', {
      platform: 'darwin',
      env: {
        HOME: '/Users/james',
        COPILOT_GITHUB_TOKEN: 'secret-token',
      },
      exec: makeExec({
        'whoami': { stdout: 'james\n' },
        'copilot --version': { stdout: 'GitHub Copilot CLI 1.0.56\n' },
        'copilot -p say ok --allow-all-tools --no-auto-update --log-level none --output-format json --stream off': {
          stdout: '{"type":"assistant.message","data":{"content":"ok"}}\n',
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.identity.username).toBe('james');
    expect(result.identity.homeDir).toBe('/Users/james');
    expect(result.provider.authenticated).toBe(true);
    expect(result.provider.tokenEnv).toEqual({ COPILOT_GITHUB_TOKEN: true, GH_TOKEN: false, GITHUB_TOKEN: false });
  });
});
