import { createBrowserMcpTools } from '../../browser-gateway/browser-mcp-tools';
import { createOrchestratorToolsForwarderTools } from '../../mcp/orchestrator-tools-mcp-forwarder';
import { createDeferredOrchestratorTools } from '../../mcp/orchestrator-mcp-deferral';

// Harness tools an ask-first Claude session may call without asking: reads, and
// automation_result, which only records the outcome of the scheduled job that owns
// the calling session (Harness refuses it anywhere else). Tools that act, including
// plan_queue_answer (it can answer a worker's question meant for a person), are held
// for approval instead. Names reaching argv are derived from the server catalogs below.
const ORCHESTRATOR_ALLOWED = [
  'list_remote_nodes', 'get_setting', 'list_settings', 'read_node_output', 'orchestrator.tool_search', 'orchestrator.tool_describe',
  'automation_result', 'plan_queue_status',
];
const BROWSER_READS = ['browser.health', 'browser.get_audit_log', 'browser.list_targets', 'browser.snapshot', 'browser.screenshot'];
const ORCHESTRATOR_TOOL_PREFIX = 'mcp__orchestrator__';

export function harnessAllowedToolsFromCatalog(orchestrator: readonly { name: string }[], browser: readonly { name: string }[]): string[] {
  const select = (server: string, catalog: readonly { name: string }[], policy: string[]) => policy.map(name => {
    const tool = catalog.find(candidate => candidate.name === name);
    if (!tool) throw new Error(`Harness allowed tool is missing from its catalog: ${server}/${name}`);
    return `mcp__${server}__${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  });
  return [...select('orchestrator', orchestrator, ORCHESTRATOR_ALLOWED), ...select('browser-gateway', browser, BROWSER_READS)];
}

/**
 * Claude hook matcher (a regular expression) for every orchestrator tool that is
 * not in `allowed`. Those calls are held by the permission hook so a person can
 * approve the waiting call; a tool added to the server later is held too.
 */
export function heldOrchestratorToolMatcher(allowed: readonly string[]): string {
  const names = allowed.filter(name => name.startsWith(ORCHESTRATOR_TOOL_PREFIX))
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `^(?!(?:${names.join('|')})$)${ORCHESTRATOR_TOOL_PREFIX}`;
}

const catalogClient = { call: async (): Promise<never> => { throw new Error('Catalog construction must not invoke tools.'); } };
export const HARNESS_ALLOWED_TOOLS: readonly string[] = harnessAllowedToolsFromCatalog(
  createDeferredOrchestratorTools(createOrchestratorToolsForwarderTools(catalogClient), { onReveal: () => undefined }),
  createBrowserMcpTools(catalogClient),
);
export const HELD_ORCHESTRATOR_TOOL_MATCHER = heldOrchestratorToolMatcher(HARNESS_ALLOWED_TOOLS);
