import { beforeEach, describe, expect, it } from 'vitest';
import type { McpServerToolDefinition } from './mcp-server-tools';
import { McpServer } from './mcp-server';
import { createBrowserMcpTools } from '../browser-gateway/browser-mcp-tools';
import { createDeferredBrowserMcpTools, measureToolSchemaBytes } from '../browser-gateway/browser-mcp-deferral';
import { createStableBrowserMcpTools } from '../browser-gateway/browser-mcp-stable-tools';
import { createOrchestratorToolsForwarderTools } from './orchestrator-tools-mcp-forwarder';
import { createDeferredOrchestratorTools, measureOrchestratorToolSchemaBytes } from './orchestrator-mcp-deferral';
import { createStableOrchestratorTools } from './orchestrator-mcp-stable-tools';

const client = { call: async () => ({}) };
const all = () => createOrchestratorToolsForwarderTools(client, { sessionMessagingEnabled: true });
const deferred = (remoteWorkersConnected: boolean) => createDeferredOrchestratorTools(all(), { onReveal: () => undefined, remoteWorkersConnected });
const stable = (remoteWorkersConnected: boolean) => createStableOrchestratorTools(all(), { remoteWorkersConnected });
// Initial advertised-byte ceilings are measured after server registration,
// including annotations and receipt paging schemas. Rounded to 1 KiB. Any
// later increase requires a reason comment and review of the added tool bytes.
const BUDGET = {
  // Main added browser.handle_dialog during integration: 71,707 advertised
  // bytes including its approval schema; round up to the next 1 KiB as above.
  // Nov-15: four reference-only Codex device-login tools bring the measured full
  // surface to 75,377 bytes. Existing tools retain their separate ceiling below.
  browserFull: { bytes: 75776, render: () => createBrowserMcpTools(client), measure: measureToolSchemaBytes },
  browserDeferred: { bytes: 12288, render: () => createDeferredBrowserMcpTools(client, { onReveal: () => undefined }), measure: measureToolSchemaBytes },
  browserStable: { bytes: 12288, render: () => createStableBrowserMcpTools(client), measure: measureToolSchemaBytes },
  // Nov-07: plan_queue_report_ready (the worker completion report, roughly 2 KB of schema)
  // takes the full set to 74,770 bytes; next 1 KiB ceiling is 75,776.
  // Nov-08: main's land-anyway change and step 5.2 (finding kind and missing, deferred_checks, criteria_total on
  // plan_queue_report_verdict, descriptions already trimmed) together measure 76,140 bytes; next 1 KiB ceiling is 76,800.
  // Nov-09: the work-source layer adds `workspace` on plan_queue_start (the saved-folder start) and `sourceRef` on the
  // triage items of plan_queue_report_triage (a source's own reference, alongside documentPath), which takes the full
  // set to 76,866 bytes; next 1 KiB ceiling is 77,824.
  // Nov-14: live-test capability repair adds four tools (report_capability_gap/_check/_probe and
  // authorize_capability_repairs), the recheck-readiness control and capability_gaps on the worker report:
  // 84,986 bytes; next 1 KiB ceiling is 84,992.
  orchestratorFull: { bytes: 84992, render: all, measure: measureOrchestratorToolSchemaBytes },
  orchestratorDeferredConnected: { bytes: 10240, render: () => deferred(true), measure: measureOrchestratorToolSchemaBytes },
  orchestratorDeferredOffline: { bytes: 4096, render: () => deferred(false), measure: measureOrchestratorToolSchemaBytes },
  orchestratorStableConnected: { bytes: 11264, render: () => stable(true), measure: measureOrchestratorToolSchemaBytes },
  orchestratorStableOffline: { bytes: 5120, render: () => stable(false), measure: measureOrchestratorToolSchemaBytes },
};

describe('advertised tool schema byte budgets', () => {
  beforeEach(() => McpServer._resetForTesting());

  it('keeps pre-dialog browser schemas within the documented credential extension', async () => {
    const server = McpServer.getInstance();
    server.registerTools(createBrowserMcpTools(client));
    const advertised = await server.handleRequest({ method: 'tools/list' }) as { tools: McpServerToolDefinition[] };
    const dialog = advertised.tools.filter(tool => tool.name === 'browser.handle_dialog');
    expect(dialog).toHaveLength(1);
    const deviceLogin = advertised.tools.filter(tool => tool.name.endsWith('_device_login'));
    expect(deviceLogin).toHaveLength(4);
    expect(measureToolSchemaBytes(deviceLogin)).toBeLessThanOrEqual(4096);
    // The new approval-aware tool accounts for 1,435 bytes. The rest still
    // newer HEAD also adds 817 bytes for email-code sender authorization and
    // one-use code submission guidance. Its next 1 KiB ceiling is 71,680;
    // device-login tools are measured separately, preserving this older ceiling.
    expect(measureToolSchemaBytes(dialog)).toBeLessThanOrEqual(1536);
    expect(measureToolSchemaBytes(advertised.tools.filter(tool =>
      tool.name !== 'browser.handle_dialog' && !tool.name.endsWith('_device_login')))).toBeLessThanOrEqual(71680);
  });

  it.each(Object.entries(BUDGET))('%s stays within its measured ceiling', async (_surface, entry) => {
    const tools = entry.render();
    const server = McpServer.getInstance();
    server.registerTools(tools);
    const advertised = await server.handleRequest({ method: 'tools/list' }) as { tools: McpServerToolDefinition[] };
    expect(advertised.tools.every(tool => typeof tool.annotations?.readOnlyHint === 'boolean')).toBe(true);
    const measured = entry.measure(advertised.tools);
    expect(measured).toBe(advertised.tools.reduce((bytes, tool) => bytes + Buffer.byteLength(JSON.stringify(tool), 'utf8'), 0));
    expect(measured).toBeLessThanOrEqual(entry.bytes);
  });
});
