import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationInvocations } from './automation-invocation-context';
import { ProviderRuntimeService } from '../providers/provider-runtime-service';
import { OrchestratorToolsRpcServer } from '../mcp/orchestrator-tools-rpc-server';
import { OrchestratorToolsRpcClient } from '../mcp/orchestrator-tools-rpc-client';
import { createAutomationToolDefinitions } from '../mcp/orchestrator-automation-tools';
import { buildOrchestratorToolsMcpConfig } from '../mcp/orchestrator-tools-mcp-config';
import { resolveOrchestratorForwarderTools } from '../mcp/orchestrator-tools-mcp-forwarder-runtime';
import { McpServer } from '../mcp/mcp-server';
import type { CliAdapter, UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';

vi.mock('electron', () => ({ app: { getPath: () => '_scratch' } }));

describe('authenticated scoped automation invocation', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); automationInvocations.reset(); McpServer._resetForTesting(); vi.unstubAllEnvs(); });
  it.each(['eager', 'deferred', 'stable'])('injects result tools at actual ephemeral spawn, maps the run and revokes at end (%s)', async mode => {
    const dir = mkdtempSync(join(process.cwd(), '_scratch', 'automation-invocation-'));
    const record = vi.fn();
    const server = new OrchestratorToolsRpcServer({ userDataPath: dir, registerCleanup: () => undefined,
      isKnownLocalInstance: () => false, canMintInstanceCapability: () => false,
      automationResult: (result, meta) => { record(automationInvocations.get(meta.callerInstanceId!)?.runId, result); return { recorded: true }; },
      toolFactory: createAutomationToolDefinitions,
    });
    await server.start(); cleanup.push(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });
    automationInvocations.configure((id, provider) => buildOrchestratorToolsMcpConfig({ aioMcpCliPath: 'test-cli', socketPath: server.getSocketPath()!,
      instanceId: id, capabilityToken: server.getInstanceCapability(id)!, provider, toolDeferral: mode !== 'eager', automationInvocation: true, exists: () => true })!);
    const root = 'automation:job:run'; automationInvocations.register(root, 'run');
    let spawned!: UnifiedSpawnOptions;
    const adapter = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => undefined) }) as unknown as CliAdapter;
    const runtime = new ProviderRuntimeService({ createAdapter: input => { spawned = input.options; return adapter; } });
    runtime.createAdapter({ cliType: mode === 'stable' ? 'codex' : 'claude', options: { workingDirectory: '/repo', instanceId: root } });
    expect(spawned.mcpConfig).toHaveLength(1);
    const env = JSON.parse(spawned.mcpConfig![0]).mcpServers.orchestrator.env;
    expect(env.AI_ORCHESTRATOR_INSTANCE_ID).not.toBe(root);
    expect(server.getInstanceCapability(root)).toBeNull();
    expect(server.getInstanceCapability('automation:forged:run')).toBeNull();
    const client = new OrchestratorToolsRpcClient({ env });
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, String(value));
    const mcp = McpServer.getInstance(); mcp.registerTools(resolveOrchestratorForwarderTools(client, names => mcp.revealTools(names)));
    const listed = await mcp.handleRequest({ method: 'tools/list' }) as { tools: { name: string }[] };
    expect(listed.tools.map(t => t.name)).toEqual(['automation_result']);
    await mcp.handleRequest({ method: 'tools/call', params: { name: 'automation_result', arguments: { outcome: 'no_change', notify: false } } });
    expect(record).toHaveBeenCalledExactlyOnceWith('run', { outcome: 'no_change', notify: false });
    await expect(client.call('orchestrator_tools.automation_result', { outcome: 'done', notify: true, runId: 'forged' })).rejects.toThrow();
    const forged = new OrchestratorToolsRpcClient({ env: { ...env, AI_ORCHESTRATOR_INSTANCE_ID: root } });
    await expect(forged.call('orchestrator_tools.automation_result', { outcome: 'done', notify: true })).rejects.toThrow();
    await expect(client.call('orchestrator_tools.list_automations', {})).rejects.toThrow(/scoped/);
    automationInvocations.revoke(root);
    await expect(client.call('orchestrator_tools.automation_result', { outcome: 'done', notify: true })).rejects.toThrow();
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('revokes an invocation capability when its adapter terminates, retaining a failed stop for retry', async () => {
    automationInvocations.configure(() => '{}'); automationInvocations.register('automation:job:run', 'run');
    const terminate = vi.fn().mockRejectedValueOnce(new Error('stop failed')).mockResolvedValue(undefined);
    const adapter = Object.assign(new EventEmitter(), { terminate }) as unknown as CliAdapter;
    const runtime = new ProviderRuntimeService({ createAdapter: () => adapter });
    runtime.createAdapter({ cliType: 'claude', options: { workingDirectory: '/repo', instanceId: 'automation:job:run' } });
    await expect(automationInvocations.stop('automation:job:run')).rejects.toThrow('stop failed');
    await automationInvocations.stop('automation:job:run');
    expect(terminate).toHaveBeenCalledTimes(2);
  });
});
