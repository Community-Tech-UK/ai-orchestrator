/**
 * `aio-mcp browser-credentials` CLI.
 *
 * 2026-08-29 deliberate widening: credential enrolment and authorization used to
 * be renderer-only, with `BrowserEnrolCredentialRequestSchema` stating that "an
 * agent must never enrol its own credential". The operator overruled that so
 * unattended portal logins need no GUI step.
 *
 * These tests pin the parts that carry the risk of that decision: the origin a
 * grant is bound to, the purposes it carries, how long it lasts, and the fact
 * that no command prints a secret.
 */
import { describe, expect, it, vi } from 'vitest';
import { runBrowserCredentialsCli } from './browser-credentials-cli';
import { BROWSER_CREDENTIALS_CLI_METHODS } from './browser-credentials-cli-contracts';

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

function harness(result: unknown) {
  const call = vi.fn().mockResolvedValue(result);
  const out: string[] = [];
  return {
    call,
    out,
    deps: {
      client: { call },
      stdout: (text: string) => out.push(text),
      now: () => NOW,
    },
    text: () => out.join(''),
  };
}

const AUTHORIZATION = {
  id: 'auth-1',
  profileId: 'default',
  allowedOrigins: [
    { scheme: 'https' as const, hostPattern: 'procontract.due-north.com', includeSubdomains: false },
  ],
  purposes: ['login' as const],
  vaultFolder: 'AIO-Agent',
  createdAt: NOW,
  expiresAt: NOW + 90 * 24 * 60 * 60 * 1000,
};

describe('browser-credentials enrol', () => {
  it('sends the item and origin and reports the binding without a secret', async () => {
    const h = harness({ vaultItemRef: 'item-9', username: 'james@communitytech.co.uk', movedIntoFolder: false });

    await runBrowserCredentialsCli(
      ['enrol', '--item', 'ProContract (AIO-Agent)', '--origin', 'https://procontract.due-north.com'],
      h.deps,
    );

    expect(h.call).toHaveBeenCalledWith(BROWSER_CREDENTIALS_CLI_METHODS.enrol, {
      item: 'ProContract (AIO-Agent)',
      origin: 'https://procontract.due-north.com',
    });
    expect(h.text()).toContain('item-9');
    expect(h.text()).toContain('moved into agent folder: no');
    expect(h.text()).not.toMatch(/password/i);
  });

  it('omits moveIntoFolder unless explicitly asked, then sends it', async () => {
    const h = harness({ vaultItemRef: 'i', username: 'u', movedIntoFolder: true });
    await runBrowserCredentialsCli(
      ['enrol', '--item', 'x', '--origin', 'https://a.example.com', '--move-into-folder'],
      h.deps,
    );
    expect(h.call.mock.calls[0]![1]).toMatchObject({ moveIntoFolder: true });
  });

  it('requires item and origin', async () => {
    const h = harness({});
    await expect(runBrowserCredentialsCli(['enrol', '--origin', 'https://a.example.com'], h.deps))
      .rejects.toThrow(/--item/);
    await expect(runBrowserCredentialsCli(['enrol', '--item', 'x'], h.deps))
      .rejects.toThrow(/--origin/);
    expect(h.call).not.toHaveBeenCalled();
  });
});

describe('browser-credentials authorize', () => {
  it('builds a grant from repeated origin and purpose flags', async () => {
    const h = harness(AUTHORIZATION);

    await runBrowserCredentialsCli([
      'authorize',
      '--node', 'windows-pc',
      '--origin', 'https://procontract.due-north.com',
      '--origin', 'https://*.due-north.com',
      '--purpose', 'login',
      '--purpose', 'totp',
      '--vault-folder', 'AIO-Agent',
      '--expires-in', '90d',
      '--note', 'ProContract unattended login',
    ], h.deps);

    expect(h.call).toHaveBeenCalledWith(BROWSER_CREDENTIALS_CLI_METHODS.authorize, {
      profileId: 'windows-pc',
      allowedOrigins: [
        { scheme: 'https', hostPattern: 'procontract.due-north.com', includeSubdomains: false },
        { scheme: 'https', hostPattern: 'due-north.com', includeSubdomains: true },
      ],
      purposes: ['login', 'totp'],
      vaultFolder: 'AIO-Agent',
      expiresAt: NOW + 90 * 24 * 60 * 60 * 1000,
      note: 'ProContract unattended login',
    });
  });

  it('deduplicates purposes and rejects an unknown one', async () => {
    const h = harness(AUTHORIZATION);
    await runBrowserCredentialsCli([
      'authorize', '--local', '--origin', 'https://a.example.com',
      '--purpose', 'login', '--purpose', 'login',
      '--vault-folder', 'f', '--expires-in', '1d',
    ], h.deps);
    expect(h.call.mock.calls[0]![1]).toMatchObject({ purposes: ['login'] });

    const h2 = harness(AUTHORIZATION);
    await expect(runBrowserCredentialsCli([
      'authorize', '--local', '--origin', 'https://a.example.com',
      '--purpose', 'secret_fill',
      '--vault-folder', 'f', '--expires-in', '1d',
    ], h2.deps)).rejects.toThrow(/Invalid purpose/);
    // secret_fill is not offerable here by design: financial and identity
    // secret fills stay off this door entirely.
    expect(h2.call).not.toHaveBeenCalled();
  });

  it('converts --expires-in days and weeks against the injected clock', async () => {
    const h = harness(AUTHORIZATION);
    await runBrowserCredentialsCli([
      'authorize', '--local', '--origin', 'https://a.example.com',
      '--purpose', 'login', '--vault-folder', 'f', '--expires-in', '2w',
    ], h.deps);
    expect(h.call.mock.calls[0]![1]).toMatchObject({
      expiresAt: NOW + 14 * 24 * 60 * 60 * 1000,
    });
  });

  it('accepts an explicit --expires-at but refuses both forms together', async () => {
    const h = harness(AUTHORIZATION);
    await runBrowserCredentialsCli([
      'authorize', '--local', '--origin', 'https://a.example.com',
      '--purpose', 'login', '--vault-folder', 'f', '--expires-at', String(NOW + 1000),
    ], h.deps);
    expect(h.call.mock.calls[0]![1]).toMatchObject({ expiresAt: NOW + 1000 });

    const h2 = harness(AUTHORIZATION);
    await expect(runBrowserCredentialsCli([
      'authorize', '--local', '--origin', 'https://a.example.com',
      '--purpose', 'login', '--vault-folder', 'f',
      '--expires-at', String(NOW + 1000), '--expires-in', '1d',
    ], h2.deps)).rejects.toThrow(/not both/);
  });

  it('requires an expiry rather than defaulting to one', async () => {
    // A silent default would mint standing consent the operator never chose.
    const h = harness(AUTHORIZATION);
    await expect(runBrowserCredentialsCli([
      'authorize', '--local', '--origin', 'https://a.example.com',
      '--purpose', 'login', '--vault-folder', 'f',
    ], h.deps)).rejects.toThrow(/--expires-in/);
    expect(h.call).not.toHaveBeenCalled();
  });

  it('rejects a malformed --expires-in', async () => {
    const h = harness(AUTHORIZATION);
    for (const bad of ['soon', '0d', '90', '3m', '-1d']) {
      await expect(runBrowserCredentialsCli([
        'authorize', '--local', '--origin', 'https://a.example.com',
        '--purpose', 'login', '--vault-folder', 'f', '--expires-in', bad,
      ], h.deps)).rejects.toThrow();
    }
    expect(h.call).not.toHaveBeenCalled();
  });
});

describe('browser-credentials list and revoke', () => {
  it('lists all authorizations, or one profile', async () => {
    const h = harness([AUTHORIZATION]);
    await runBrowserCredentialsCli(['list'], h.deps);
    expect(h.call).toHaveBeenCalledWith(BROWSER_CREDENTIALS_CLI_METHODS.list, {});
    expect(h.text()).toContain('https://procontract.due-north.com');

    const h2 = harness([AUTHORIZATION]);
    await runBrowserCredentialsCli(['list', '--profile', 'default'], h2.deps);
    expect(h2.call).toHaveBeenCalledWith(BROWSER_CREDENTIALS_CLI_METHODS.list, { profileId: 'default' });
  });

  it('renders a wildcard origin back in the form it was given', async () => {
    const h = harness([{
      ...AUTHORIZATION,
      allowedOrigins: [{ scheme: 'https', hostPattern: 'due-north.com', includeSubdomains: true }],
    }]);
    await runBrowserCredentialsCli(['list'], h.deps);
    expect(h.text()).toContain('https://*.due-north.com');
  });

  it('says so plainly when there are none', async () => {
    const h = harness([]);
    await runBrowserCredentialsCli(['list'], h.deps);
    expect(h.text()).toBe('No credential authorizations.\n');
  });

  it('revokes by id', async () => {
    const h = harness({ revoked: true });
    await runBrowserCredentialsCli(['revoke', '--id', 'auth-1'], h.deps);
    expect(h.call).toHaveBeenCalledWith(BROWSER_CREDENTIALS_CLI_METHODS.revoke, {
      authorizationId: 'auth-1',
    });
    expect(h.text()).toContain('auth-1');
  });
});

describe('browser-credentials argument handling', () => {
  it('prints help with no command and calls nothing', async () => {
    const h = harness({});
    await runBrowserCredentialsCli([], h.deps);
    expect(h.text()).toContain('Usage: aio-mcp browser-credentials');
    expect(h.call).not.toHaveBeenCalled();
  });

  it('rejects an unknown command', async () => {
    const h = harness({});
    await expect(runBrowserCredentialsCli(['delete-everything'], h.deps))
      .rejects.toThrow(/Unknown browser-credentials command/);
  });

  it('rejects a flag with a missing value instead of swallowing the next flag', async () => {
    const h = harness({});
    await expect(runBrowserCredentialsCli(['enrol', '--item', '--origin', 'https://a.example.com'], h.deps))
      .rejects.toThrow(/--item requires a value/);
  });

  it('rejects a repeated single-value flag', async () => {
    const h = harness({});
    await expect(runBrowserCredentialsCli(
      ['enrol', '--item', 'a', '--item', 'b', '--origin', 'https://a.example.com'],
      h.deps,
    )).rejects.toThrow(/only be given once/);
  });

  it('emits JSON on --json', async () => {
    const h = harness({ vaultItemRef: 'i', username: 'u', movedIntoFolder: false });
    await runBrowserCredentialsCli(
      ['enrol', '--item', 'x', '--origin', 'https://a.example.com', '--json'],
      h.deps,
    );
    expect(JSON.parse(h.text())).toEqual({ vaultItemRef: 'i', username: 'u', movedIntoFolder: false });
  });

  it('reports a malformed response rather than passing it on', async () => {
    const h = harness({ nope: true });
    await expect(runBrowserCredentialsCli(
      ['enrol', '--item', 'x', '--origin', 'https://a.example.com'],
      h.deps,
    )).rejects.toThrow(/Malformed enrolment response/);
  });
});

describe('browser-credentials scope selection', () => {
  // The defect this guards: at fill time a shared existing tab authorizes by
  // NODE scope, not by a browser profile id. `--profile default` looked
  // plausible, was accepted, and produced a grant that could never match.
  it('maps --local to the local node scope', async () => {
    const h = harness(AUTHORIZATION);
    await runBrowserCredentialsCli([
      'authorize', '--local', '--origin', 'https://a.example.com',
      '--purpose', 'login', '--vault-folder', 'f', '--expires-in', '1d',
    ], h.deps);
    expect(h.call.mock.calls[0]![1]).toMatchObject({ profileId: 'local' });
  });

  it('forwards --node verbatim, because the name is resolved main-side', async () => {
    const h = harness(AUTHORIZATION);
    await runBrowserCredentialsCli([
      'authorize', '--node', 'windows-pc', '--origin', 'https://a.example.com',
      '--purpose', 'login', '--vault-folder', 'f', '--expires-in', '1d',
    ], h.deps);
    expect(h.call.mock.calls[0]![1]).toMatchObject({ profileId: 'windows-pc' });
  });

  it('demands a scope rather than guessing one', async () => {
    const h = harness(AUTHORIZATION);
    await expect(runBrowserCredentialsCli([
      'authorize', '--origin', 'https://a.example.com',
      '--purpose', 'login', '--vault-folder', 'f', '--expires-in', '1d',
    ], h.deps)).rejects.toThrow(/--local .*--node .*--profile|Missing a scope/s);
    expect(h.call).not.toHaveBeenCalled();
  });

  it('refuses more than one scope', async () => {
    const h = harness(AUTHORIZATION);
    await expect(runBrowserCredentialsCli([
      'authorize', '--local', '--node', 'windows-pc', '--origin', 'https://a.example.com',
      '--purpose', 'login', '--vault-folder', 'f', '--expires-in', '1d',
    ], h.deps)).rejects.toThrow(/exactly one scope/);
    expect(h.call).not.toHaveBeenCalled();
  });

  it('prints the RESOLVED scope back, which is what was actually stored', async () => {
    // The operator types a name; the main side stores the roster UUID. Printing
    // back what he typed would hide a mis-resolution, so this asserts the
    // response value, which is the id.
    const nodeId = 'bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be';
    const h = harness({ ...AUTHORIZATION, profileId: nodeId });
    await runBrowserCredentialsCli([
      'authorize', '--node', 'windows-pc', '--origin', 'https://a.example.com',
      '--purpose', 'login', '--vault-folder', 'f', '--expires-in', '1d',
    ], h.deps);
    expect(h.call.mock.calls[0]![1]).toMatchObject({ profileId: 'windows-pc' });
    expect(h.text()).toContain(`scope: ${nodeId}`);
  });
});

describe('browser-credentials error remediation', () => {
  // This runs unattended. A bare failure with no next step is a dead end in a
  // log at 3am, so known failures carry the fix.
  function failing(message: string) {
    const call = vi.fn().mockRejectedValue(new Error(message));
    return { call, deps: { client: { call }, stdout: () => undefined, now: () => NOW } };
  }

  it('tells you how to unlock a locked vault', async () => {
    const h = failing('Credential vault is locked (no BW_SESSION)');
    await expect(runBrowserCredentialsCli(
      ['enrol', '--item', 'x', '--origin', 'https://a.example.com'],
      h.deps,
    )).rejects.toThrow(/browserVaultAutoUnlock|unlock the vault/);
  });

  it('names --move-into-folder when the item is outside the agent folder', async () => {
    const h = failing("Vault item abc is not inside the AIO-Agent folder");
    await expect(runBrowserCredentialsCli(
      ['enrol', '--item', 'x', '--origin', 'https://a.example.com'],
      h.deps,
    )).rejects.toThrow(/--move-into-folder/);
  });

  it('passes an unrecognised failure through unchanged', async () => {
    const h = failing('something else entirely');
    await expect(runBrowserCredentialsCli(
      ['enrol', '--item', 'x', '--origin', 'https://a.example.com'],
      h.deps,
    )).rejects.toThrow(/^something else entirely$/);
  });
});
