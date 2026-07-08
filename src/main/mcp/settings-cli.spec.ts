import { describe, expect, it, vi } from 'vitest';
import { formatSettingsListTable, runSettingsCli } from './settings-cli';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';

function stdoutText(stdout: ReturnType<typeof vi.fn>): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

function clientReturning(result: unknown): OrchestratorToolsRpcClientLike & {
  call: ReturnType<typeof vi.fn>;
} {
  return {
    call: vi.fn(async () => result),
  };
}

describe('settings-cli', () => {
  it('prints help without contacting the parent RPC server', async () => {
    const stdout = vi.fn();
    const client = clientReturning({});

    await runSettingsCli(['--help'], { client, stdout });

    expect(client.call).not.toHaveBeenCalled();
    expect(stdoutText(stdout)).toContain('Usage: aio-mcp settings');
  });

  it('rejects unknown options before contacting the parent RPC server', async () => {
    const client = clientReturning({});

    await expect(
      runSettingsCli(['list', '--wat'], { client, stdout: vi.fn() }),
    ).rejects.toThrow(/Unknown settings option: --wat/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('calls privileged_list with category and all filters and prints redacted rows', async () => {
    const stdout = vi.fn();
    const client = clientReturning({
      count: 2,
      settings: [
        {
          key: 'theme',
          value: 'dark',
          defaultValue: 'dark',
          type: 'select',
          category: 'display',
          writable: true,
          restartRequired: false,
          description: 'Color theme.',
          policyTier: 'open',
        },
        {
          key: 'remoteNodesEnrollmentToken',
          value: '[redacted]',
          defaultValue: '[redacted]',
          type: 'string',
          category: 'remote-nodes',
          writable: false,
          restartRequired: false,
          description: 'Enrollment token.',
          policyTier: 'secret',
        },
      ],
    });

    await runSettingsCli(['list', '--category', 'remote-nodes', '--all'], { client, stdout });

    expect(client.call).toHaveBeenCalledWith(
      'orchestrator_tools.settings.privileged_list',
      { category: 'remote-nodes', all: true },
    );
    const output = stdoutText(stdout);
    expect(output).toContain('remoteNodesEnrollmentToken');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('redaction-test-value');
  });

  it('prints privileged_list JSON without leaking redacted secret values', async () => {
    const stdout = vi.fn();
    const client = clientReturning({
      count: 1,
      settings: [{
        key: 'remoteNodesEnrollmentToken',
        value: '[redacted]',
        defaultValue: '[redacted]',
        type: 'string',
        category: 'remote-nodes',
        writable: false,
        restartRequired: false,
        description: 'Enrollment token.',
        policyTier: 'secret',
      }],
    });

    await runSettingsCli(['list', '--json'], { client, stdout });

    expect(client.call).toHaveBeenCalledWith(
      'orchestrator_tools.settings.privileged_list',
      {},
    );
    const parsed = JSON.parse(stdoutText(stdout)) as { settings: Array<{ value: unknown }> };
    expect(parsed.settings[0]?.value).toBe('[redacted]');
  });

  it('calls privileged_get for a single key and prints JSON when requested', async () => {
    const stdout = vi.fn();
    const client = clientReturning({
      key: 'theme',
      value: 'dark',
      restartRequired: false,
      writable: true,
      policyTier: 'open',
    });

    await runSettingsCli(['get', 'theme', '--json'], { client, stdout });

    expect(client.call).toHaveBeenCalledWith(
      'orchestrator_tools.settings.privileged_get',
      { key: 'theme' },
    );
    expect(JSON.parse(stdoutText(stdout))).toMatchObject({ key: 'theme', value: 'dark' });
  });

  it('parses set values as JSON first and falls back to plain strings', async () => {
    const stdout = vi.fn();
    const client: OrchestratorToolsRpcClientLike & { call: ReturnType<typeof vi.fn> } = {
      call: vi.fn(async (method: string, payload: Record<string, unknown>) => ({
        ok: true,
        key: payload['key'],
        oldValue: null,
        newValue: payload['value'],
        restartRequired: false,
      })),
    };

    await runSettingsCli(['set', 'remoteNodesEnabled', 'true'], { client, stdout });
    await runSettingsCli(['set', 'maxTotalInstances', '20'], { client, stdout });
    await runSettingsCli([
      'set',
      'defaultModelByProvider',
      '{"codex":"gpt-5.1-codex"}',
    ], { client, stdout });
    await runSettingsCli([
      'set',
      'crossModelReviewProviders',
      '["codex","cursor"]',
    ], { client, stdout });
    await runSettingsCli(['set', 'defaultModel', 'gpt-5.1-codex'], { client, stdout });

    expect(client.call.mock.calls.map((call) => call[1])).toEqual([
      { key: 'remoteNodesEnabled', value: true },
      { key: 'maxTotalInstances', value: 20 },
      { key: 'defaultModelByProvider', value: { codex: 'gpt-5.1-codex' } },
      { key: 'crossModelReviewProviders', value: ['codex', 'cursor'] },
      { key: 'defaultModel', value: 'gpt-5.1-codex' },
    ]);
  });

  it('does not echo raw secret set values in terminal output', async () => {
    const stdout = vi.fn();
    const client = clientReturning({
      ok: true,
      key: 'remoteNodesEnrollmentToken',
      oldValue: '[redacted]',
      newValue: '[redacted]',
      restartRequired: false,
    });

    await runSettingsCli(
      ['set', 'remoteNodesEnrollmentToken', 'redaction-test-value'],
      { client, stdout },
    );

    expect(client.call).toHaveBeenCalledWith(
      'orchestrator_tools.settings.privileged_set',
      { key: 'remoteNodesEnrollmentToken', value: 'redaction-test-value' },
    );
    const output = stdoutText(stdout);
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('redaction-test-value');
  });

  it('calls privileged_reset for a single key', async () => {
    const stdout = vi.fn();
    const client = clientReturning({
      ok: true,
      key: 'defaultYoloMode',
      oldValue: true,
      newValue: false,
      restartRequired: false,
    });

    await runSettingsCli(['reset', 'defaultYoloMode'], { client, stdout });

    expect(client.call).toHaveBeenCalledWith(
      'orchestrator_tools.settings.privileged_reset',
      { key: 'defaultYoloMode' },
    );
    expect(stdoutText(stdout)).toContain('defaultYoloMode');
  });

  it('formats empty list results clearly', () => {
    expect(formatSettingsListTable({ count: 0, settings: [] })).toContain('No settings matched');
  });
});
