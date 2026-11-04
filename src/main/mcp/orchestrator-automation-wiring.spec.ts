import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));
vi.mock('../db/better-sqlite3-driver', () => ({
  defaultDriverFactory: () => ({ pragma: vi.fn(), close: vi.fn() }),
}));
vi.mock('../operator/operator-schema', () => ({ createOperatorTables: vi.fn() }));
vi.mock('../instance/session-messages-schema', () => ({ createSessionMessagesTables: vi.fn() }));
vi.mock('../conversation-ledger', () => ({ getConversationLedgerService: () => null }));
vi.mock('../operator/operator-database', () => ({ defaultOperatorDbPath: () => 'unused-test-db' }));

import { OrchestratorToolsRpcServer } from './orchestrator-tools-rpc-server';
import { OrchestratorToolsRpcClient } from './orchestrator-tools-rpc-client';
import { createOrchestratorToolDefinitions } from './orchestrator-tools';
import { createAutomationToolDefinitions } from './orchestrator-automation-tools';
import { resolveOrchestratorForwarderTools } from './orchestrator-tools-mcp-forwarder-runtime';
import { ORCHESTRATOR_TOOL_DEFERRAL_ENV, ORCHESTRATOR_TOOL_SEARCH_NAME } from './orchestrator-mcp-deferral';
import { ORCHESTRATOR_TOOL_STABLE_ENV } from './orchestrator-mcp-stable-tools';
import { McpServer } from './mcp-server';

describe('scheduled result first-turn authenticated forwarding', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    McpServer._resetForTesting();
    vi.unstubAllEnvs();
  });

  it.each(['eager', 'deferred', 'stable'] as const)(
    'lists and executes automation_result before any search in %s mode', async mode => {
      vi.stubEnv(ORCHESTRATOR_TOOL_DEFERRAL_ENV, mode === 'deferred' ? '1' : '0');
      vi.stubEnv(ORCHESTRATOR_TOOL_STABLE_ENV, mode === 'stable' ? '1' : '0');
      const automationResult = vi.fn(() => ({ recorded: true }));
      const dir = mkdtempSync(join(tmpdir(), 'step9-result-'));
      const server = new OrchestratorToolsRpcServer({
        userDataPath: dir, isKnownLocalInstance: id => id === 'scheduled-caller',
        registerCleanup: () => undefined, automationResult,
        // Exercise both runtime-context construction paths with the real tool factory.
        ...(mode === 'deferred' ? { toolFactory: createOrchestratorToolDefinitions } : {}),
        resolveSpawnEligibility: () => false,
      });
      cleanups.push(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });
      await server.start();
      const env = {
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: server.getSocketPath()!,
        AI_ORCHESTRATOR_INSTANCE_ID: 'scheduled-caller',
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY: server.getInstanceCapability('scheduled-caller')!,
      };
      const client = new OrchestratorToolsRpcClient({ env });
      const mcp = McpServer.getInstance();
      mcp.registerTools(resolveOrchestratorForwarderTools(client, names => mcp.revealTools(names)));
      const listed = await mcp.handleRequest({ method: 'tools/list' }) as { tools: { name: string; description: string; inputSchema: unknown }[] };
      const resultTool = listed.tools.find(tool => tool.name === 'automation_result');
      expect(resultTool).toBeDefined();
      const scoped = createAutomationToolDefinitions({}).find(tool => tool.name === 'automation_result')!;
      expect(resultTool).toMatchObject({ description: scoped.description, inputSchema: scoped.inputSchema });
      await mcp.handleRequest({ method: 'tools/call', params: {
        name: 'automation_result', arguments: { outcome: 'no_change', notify: false },
      } });
      expect(automationResult).toHaveBeenCalledExactlyOnceWith(
        { outcome: 'no_change', notify: false }, { callerInstanceId: 'scheduled-caller' },
      );
      if (mode !== 'eager') {
        const search = await mcp.handleRequest({ method: 'tools/call', params: {
          name: ORCHESTRATOR_TOOL_SEARCH_NAME, arguments: { query: 'automation_result', limit: 10 },
        } });
        expect(JSON.stringify(search)).toContain('automation_result');
      }
      // A different valid instance identity cannot borrow this session's capability.
      const forged = new OrchestratorToolsRpcClient({ env: { ...env, AI_ORCHESTRATOR_INSTANCE_ID: 'other-caller' } });
      await expect(forged.call('orchestrator_tools.automation_result', { outcome: 'done', notify: true }))
        .rejects.toThrow(/capability/);
      await expect(client.call('orchestrator_tools.automation_result', {
        outcome: 'done', notify: true, callerInstanceId: 'other-caller',
      })).rejects.toThrow();
      expect(automationResult).toHaveBeenCalledTimes(1);
    },
  );

  it('forwards the scheduled policy fields from the scoped automation schemas', () => {
    const tools = resolveOrchestratorForwarderTools({ call: vi.fn() }, vi.fn());
    for (const name of ['create_automation', 'update_automation']) {
      const scoped = createAutomationToolDefinitions({}).find(tool => tool.name === name)!;
      expect(tools.find(tool => tool.name === name)?.inputSchema).toEqual(scoped.inputSchema);
    }
  });

  it('keeps automation and parent tool runtimes out of the SEA forwarder dependency graph', () => {
    // esbuild requires Node's own typed-array realm, not the renderer test realm.
    const inputs = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { build } from 'esbuild';
      const result = await build({
        entryPoints: ['src/main/mcp/orchestrator-tools-mcp-forwarder-runtime.ts'],
        bundle: true, platform: 'node', format: 'cjs', write: false, metafile: true,
        tsconfig: 'tsconfig.electron.json', logLevel: 'silent',
        external: ['electron', 'better-sqlite3', '@sqlite.org/sqlite-wasm'],
      });
      process.stdout.write(JSON.stringify(Object.keys(result.metafile.inputs)));
    `], { encoding: 'utf8', timeout: 20_000 })) as string[];
    expect(inputs).toContain('src/main/mcp/orchestrator-automation-tools.ts');
    expect(inputs.some(path => path.startsWith('src/main/automations/'))).toBe(false);
    expect(inputs).not.toContain('src/main/mcp/orchestrator-tools.ts');
  });
});
