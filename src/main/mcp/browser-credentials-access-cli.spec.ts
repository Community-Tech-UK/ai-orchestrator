import { describe, expect, it, vi } from 'vitest';
import { runBrowserCredentialsCli } from './browser-credentials-cli';

function result(status: 'pending' | 'approved' | 'denied' | 'expired' = 'pending') {
  return {
    decision: status === 'pending' ? 'requires_user' : 'allowed',
    outcome: status === 'pending' ? 'not_run' : 'succeeded',
    auditId: 'audit-1', requestId: 'request-1',
    data: {
      id: 'request-1', requestId: 'request-1', instanceId: 'instance-1',
      provider: 'codex', profileId: 'profile-1', targetId: 'target-1',
      toolName: 'browser.request_credential_access', action: 'credential_access', actionClass: 'credential',
      origin: 'https://portal.example.com', status, createdAt: 1, expiresAt: 2,
      proposedGrant: {
        mode: 'session', allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.com', includeSubdomains: false }],
        allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: false,
      },
      credentialAccess: {
        taskScope: 'task-1', sessionName: 'Test session', reason: 'Sign in for this task',
        origin: 'https://portal.example.com', computerName: 'windows-pc', computerId: 'node-1', scope: 'node-1',
        vaultItemRef: 'item-1', itemTitle: 'Portal test login', vaultFolder: 'AIO-Agent',
        moveIntoFolder: false, purposes: ['login'], permission: 'task',
        ...(status === 'approved' ? { authorizationId: 'authorization-1' } : {}),
      },
    },
  };
}

function harness(response: unknown) {
  const call = vi.fn().mockResolvedValue(response);
  const output: string[] = [];
  return { call, output, deps: { client: { call }, stdout: (text: string) => output.push(text) } };
}

const requestArgs = ['request', '--profile', 'profile-1', '--target', 'target-1', '--item', 'Portal test login', '--reason', 'Sign in for this task'];

describe('browser-credentials approved-access CLI', () => {
  it('requests bounded access and reports a real pending reference', async () => {
    const h = harness(result());
    await runBrowserCredentialsCli(requestArgs, h.deps);
    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.browser_credentials.request', {
      profileId: 'profile-1', targetId: 'target-1', item: 'Portal test login', reason: 'Sign in for this task',
    });
    expect(h.output.join('')).toContain('request-1: pending');
    expect(h.output.join('')).toContain('approval in Harness');
    expect(h.output.join('')).not.toContain('Authorization created');
  });

  it('deduplicates only login and totp purposes without allowing an agent lifetime choice', async () => {
    const h = harness(result());
    await runBrowserCredentialsCli([...requestArgs, '--purpose', 'login', '--purpose', 'login', '--purpose', 'totp'], h.deps);
    expect(h.call.mock.calls[0]?.[1]).toMatchObject({ purposes: ['login', 'totp'] });
    for (const flags of [['--expires-in', '1d'], ['--purpose', 'secret_fill'], ['--move-into-folder'], ['--local']]) {
      const rejected = harness(result());
      await expect(runBrowserCredentialsCli([...requestArgs, ...flags], rejected.deps)).rejects.toThrow();
      expect(rejected.call).not.toHaveBeenCalled();
    }
  });

  it.each(['pending', 'approved', 'denied', 'expired'] as const)('reports the real %s decision when polling', async (status) => {
    const h = harness(result(status));
    await runBrowserCredentialsCli(['status', '--id', 'request-1', '--json'], h.deps);
    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.browser_credentials.status', { requestId: 'request-1' });
    expect(JSON.parse(h.output.join('')).data.status).toBe(status);
  });

  it('cancels the existing request instead of creating a new authorization', async () => {
    const h = harness(result('denied'));
    await runBrowserCredentialsCli(['cancel', '--id', 'request-1'], h.deps);
    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.browser_credentials.cancel', { requestId: 'request-1' });
    expect(h.output.join('')).toContain('request-1: denied');
  });

  it('rejects mismatched approval and polling references', async () => {
    const response = result();
    const h = harness({ ...response, data: { ...response.data, id: 'approval-record-1' } });
    await expect(runBrowserCredentialsCli(requestArgs, h.deps)).rejects.toThrow(/Malformed credential access/);
    expect(h.output).toEqual([]);
  });

  it('refuses manual handoffs and approved requests with no completed authorization', async () => {
    const manual = result('approved');
    const noMetadata = { ...manual, data: { ...manual.data, credentialAccess: undefined } };
    const noAuthorization = { ...manual, data: { ...manual.data, credentialAccess: { ...manual.data.credentialAccess, authorizationId: undefined } } };
    for (const response of [noMetadata, noAuthorization]) {
      const h = harness(response);
      await expect(runBrowserCredentialsCli(['status', '--id', 'request-1'], h.deps)).rejects.toThrow(/Malformed credential access/);
      expect(h.output).toEqual([]);
    }
  });

  it('rejects responses carrying unexpected credential fields without printing them', async () => {
    const response = result();
    const h = harness({ ...response, data: { ...response.data, password: 'PLACEHOLDER_PASSWORD' } });
    await expect(runBrowserCredentialsCli(requestArgs, h.deps)).rejects.toThrow(/Malformed credential access/);
    expect(h.output).toEqual([]);
  });
});
