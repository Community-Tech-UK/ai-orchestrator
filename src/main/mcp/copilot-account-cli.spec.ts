import { describe, expect, it, vi } from 'vitest';
import { parseRouteArgs, runCopilotAccountCli } from './copilot-account-cli';
import { COPILOT_ACCOUNT_CLI_METHODS } from './copilot-account-cli-contracts';
import { dispatchCopilotAccountCliRpc } from './orchestrator-tools-rpc-copilot-account';

function cli(result: unknown) {
  const calls: { method: string; payload: unknown }[] = [];
  const out: string[] = [];
  const client = {
    call: async (method: string, payload: Record<string, unknown>) => {
      calls.push({ method, payload });
      return result;
    },
  };
  return { client, calls, out, stdout: (text: string) => out.push(text) };
}

const profile = {
  id: 'enterprise',
  label: 'Enterprise',
  expectedLogin: 'LAWRENCJ_PE1',
  host: 'github.com',
  accountKind: 'enterprise',
  scopePolicy: 'matched-only',
  automationPolicy: 'allow-routed',
  isDefault: false,
  bindingState: 'authenticated',
};

describe('aio-mcp copilot-account', () => {
  it('lists accounts with their identity and sign-in state', async () => {
    const h = cli([profile]);
    await runCopilotAccountCli(['list'], { client: h.client, stdout: h.stdout });
    const text = h.out.join('');
    expect(text).toContain('LAWRENCJ_PE1');
    expect(text).toContain('authenticated');
    expect(h.calls[0].method).toBe(COPILOT_ACCOUNT_CLI_METHODS.list);
  });

  it('explains which account a workspace resolves to, and why', async () => {
    const h = cli({ ok: true, profileId: 'enterprise', profileLabel: 'Enterprise', source: 'owner', detail: null, origin: 'interactive' });
    await runCopilotAccountCli(['route', '/Users/me/work/ebrd'], { client: h.client, stdout: h.stdout });
    expect(h.out.join('')).toContain('Enterprise (owner, as interactive)');
    expect(h.calls[0].payload).toEqual({ payload: { workingDirectory: '/Users/me/work/ebrd' } });
  });

  it('reports a blocked workspace rather than implying it will run', async () => {
    const h = cli({
      ok: false,
      profileId: 'enterprise',
      profileLabel: null,
      source: 'profile-unauthenticated',
      detail: 'Copilot account "Enterprise" is not signed in on this device.',
      origin: 'interactive',
    });
    await runCopilotAccountCli(['route', '/w'], { client: h.client, stdout: h.stdout });
    expect(h.out.join('')).toContain('Blocked as interactive: Copilot account "Enterprise" is not signed in');
  });

  it('requires a path for route rather than silently reading the cwd', async () => {
    const h = cli(null);
    await expect(runCopilotAccountCli(['route'], { client: h.client, stdout: h.stdout }))
      .rejects.toThrow(/Usage: aio-mcp copilot-account route/);
  });

  it('says where to make changes, since this surface is read-only by design', async () => {
    const h = cli(null);
    await runCopilotAccountCli(['--help'], { client: h.client, stdout: h.stdout });
    const text = h.out.join('');
    expect(text).toContain('Read-only');
    expect(text).toContain('Settings');
    // No write verbs may appear in help: their absence is the security contract.
    expect(text).not.toMatch(/^\s+(add|remove|set-default|map)\b/m);
  });
});

describe('the CLI response gate covers EVERY method, not just list', () => {
  // Round-13 finding: only `list` had a negative test, so dropping `.strict()`
  // from the other three schemas left all tests green. That is the same
  // "covered one field, not its four siblings" pattern this feature has been
  // bitten by repeatedly, so each method gets its own leak case.
  const ops = (overrides: Record<string, unknown> = {}) => ({
    list: async () => [profile],
    rules: async () => [{ id: 'r1', profileId: 'p', kind: 'owner', target: 'github.com/acme/*', isProtected: false }],
    route: async () => ({ ok: true, profileId: 'p', profileLabel: 'P', source: 'default', detail: null, origin: 'interactive' }),
    doctor: async () => ({
      aggregate: 'available', nodeId: 'local', legacyMigrationInUse: false,
      ambientTokenVariablesPresent: [], unreachableRuleIds: [], conflictingRuleIds: [], warnings: [],
    }),
    ...overrides,
  }) as never;

  const HOME = '/Users/me/Library/Application Support/Harness/copilot-cli-profiles/enterprise';

  it('refuses a profile carrying a Copilot home path', async () => {
    await expect(
      dispatchCopilotAccountCliRpc(COPILOT_ACCOUNT_CLI_METHODS.list, {}, ops({
        list: async () => [{ ...profile, home: HOME }],
      })),
    ).rejects.toThrow();
  });

  it('refuses a RULE carrying an extra field', async () => {
    await expect(
      dispatchCopilotAccountCliRpc(COPILOT_ACCOUNT_CLI_METHODS.rules, {}, ops({
        rules: async () => [{ id: 'r1', profileId: 'p', kind: 'owner', target: 'github.com/acme/*', isProtected: false, home: HOME }],
      })),
    ).rejects.toThrow();
  });

  it('refuses a ROUTE carrying an extra field', async () => {
    await expect(
      dispatchCopilotAccountCliRpc(
        COPILOT_ACCOUNT_CLI_METHODS.route,
        { workingDirectory: '/w' },
        ops({ route: async () => ({ ok: true, profileId: 'p', profileLabel: 'P', source: 'default', detail: null, origin: 'interactive', home: HOME }) }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a DOCTOR report carrying an extra field', async () => {
    await expect(
      dispatchCopilotAccountCliRpc(COPILOT_ACCOUNT_CLI_METHODS.doctor, {}, ops({
        doctor: async () => ({
          aggregate: 'available', nodeId: 'local', legacyMigrationInUse: false,
          ambientTokenVariablesPresent: [], unreachableRuleIds: [], conflictingRuleIds: [], warnings: [],
          home: HOME,
        }),
      })),
    ).rejects.toThrow();
  });

  it('accepts every method\'s clean payload', async () => {
    // Guards against the negative tests passing for the wrong reason.
    await expect(dispatchCopilotAccountCliRpc(COPILOT_ACCOUNT_CLI_METHODS.list, {}, ops())).resolves.toBeDefined();
    await expect(dispatchCopilotAccountCliRpc(COPILOT_ACCOUNT_CLI_METHODS.rules, {}, ops())).resolves.toBeDefined();
    await expect(dispatchCopilotAccountCliRpc(COPILOT_ACCOUNT_CLI_METHODS.route, { workingDirectory: '/w' }, ops())).resolves.toBeDefined();
    await expect(dispatchCopilotAccountCliRpc(COPILOT_ACCOUNT_CLI_METHODS.doctor, {}, ops())).resolves.toBeDefined();
  });

  it('rejects an unknown --origin instead of silently previewing the default', async () => {
    const h = cli(null);
    await expect(runCopilotAccountCli(['route', '/w', '--origin=bogus'], { client: h.client, stdout: h.stdout }))
      .rejects.toThrow(/Unknown origin/);
  });
});

describe('route argument parsing', () => {
  // Found by review on 2026-08-30. The path was "the first token not starting
  // with --", so the space form's VALUE was taken as the workspace:
  // `route --origin automation /real/path` previewed a folder literally named
  // "automation" and reported on it confidently.
  it('does not swallow the path when --origin is space-separated', () => {
    expect(parseRouteArgs(['--origin', 'automation', '/real/path'])).toEqual({
      workingDirectory: '/real/path',
      origin: 'automation',
    });
  });

  it('accepts the equals form too', () => {
    expect(parseRouteArgs(['/real/path', '--origin=review'])).toEqual({
      workingDirectory: '/real/path',
      origin: 'review',
    });
  });

  it('refuses --origin with no value rather than silently assuming interactive', () => {
    expect(() => parseRouteArgs(['/w', '--origin'])).toThrow(/--origin requires a value/);
    expect(() => parseRouteArgs(['--origin', '--json', '/w'])).toThrow(/--origin requires a value/);
  });

  it('still rejects an unknown origin in either form', () => {
    expect(() => parseRouteArgs(['/w', '--origin=bogus'])).toThrow(/Unknown origin/);
    expect(() => parseRouteArgs(['--origin', 'bogus', '/w'])).toThrow(/Unknown origin/);
  });

  it('ignores unrelated flags without treating them as the path', () => {
    expect(parseRouteArgs(['--json', '/w'])).toEqual({ workingDirectory: '/w' });
  });

  it('requires a path', () => {
    expect(() => parseRouteArgs(['--json'])).toThrow(/Usage: aio-mcp copilot-account route/);
  });
});
