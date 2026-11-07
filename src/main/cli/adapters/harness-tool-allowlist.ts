import { createBrowserMcpTools } from '../../browser-gateway/browser-mcp-tools';
import { createOrchestratorToolsForwarderTools } from '../../mcp/orchestrator-tools-mcp-forwarder';
import { createDeferredOrchestratorTools } from '../../mcp/orchestrator-mcp-deferral';

// Explicit policy subsets. Names reaching argv are derived from the server catalogs below.
const ORCHESTRATOR_READS = ['list_remote_nodes', 'get_setting', 'list_settings', 'read_node_output', 'orchestrator.tool_search', 'orchestrator.tool_describe'];
const BROWSER_READS = ['browser.health', 'browser.get_audit_log', 'browser.list_targets', 'browser.snapshot', 'browser.screenshot'];

export function harnessReadOnlyToolsFromCatalog(orchestrator: readonly { name: string }[], browser: readonly { name: string }[]): string[] {
  const select = (server: string, catalog: readonly { name: string }[], policy: string[]) => policy.map(name => {
    const tool = catalog.find(candidate => candidate.name === name);
    if (!tool) throw new Error(`Harness read-only tool is missing from its catalog: ${server}/${name}`);
    return `mcp__${server}__${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  });
  return [...select('orchestrator', orchestrator, ORCHESTRATOR_READS), ...select('browser-gateway', browser, BROWSER_READS)];
}
const catalogClient = { call: async (): Promise<never> => { throw new Error('Catalog construction must not invoke tools.'); } };
export const HARNESS_READ_ONLY_TOOLS: readonly string[] = harnessReadOnlyToolsFromCatalog(
  createDeferredOrchestratorTools(createOrchestratorToolsForwarderTools(catalogClient), { onReveal: () => undefined }),
  createBrowserMcpTools(catalogClient),
);
