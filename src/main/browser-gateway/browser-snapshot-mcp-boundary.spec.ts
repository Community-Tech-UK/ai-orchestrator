import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '../mcp/mcp-server';
import { _setToolOutputDirForTesting } from '../util/tool-output-truncation';
import { BrowserGatewayRpcServer } from './browser-gateway-rpc-server';
import { BrowserGatewayRpcClient } from './browser-gateway-rpc-client';
import { createBrowserMcpTools } from './browser-mcp-tools';
import { createDeferredBrowserMcpTools } from './browser-mcp-deferral';
import { BROWSER_TOOL_EXECUTE_NAME, createStableBrowserMcpTools } from './browser-mcp-stable-tools';
import { boundBrowserText } from './browser-redaction';

function text(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return content[0].text;
}

// Real registrations and socket serialization; page production is an inert service seam.
// No browser, provider or operator data is accessed.
describe.each(['eager', 'deferred', 'stable'] as const)('Step 9d browser snapshot through %s MCP registration', mode => {
  let rpc: BrowserGatewayRpcServer;
  let server: McpServer;
  let dir: string;
  let outputs: string;
  const snapshot = vi.fn();
  const getHealth = vi.fn();
  const screenshot = vi.fn();
  const target = { profileId: 'profile-placeholder', targetId: 'target-placeholder' };

  beforeEach(async () => {
    McpServer._resetForTesting();
    server = McpServer.getInstance();
    snapshot.mockReset(); getHealth.mockReset(); screenshot.mockReset();
    dir = mkdtempSync(join(tmpdir(), 'aio-snapshot-boundary-'));
    outputs = join(dir, 'outputs');
    _setToolOutputDirForTesting(outputs);
    rpc = new BrowserGatewayRpcServer({
      service: { snapshot, getHealth, screenshot }, userDataPath: dir,
      isKnownLocalInstance: id => ['instance-placeholder', 'other-placeholder'].includes(id),
      registerCleanup: vi.fn(), routeBrowserRequest: (_method, payload) => payload,
    });
    await rpc.start();
    register(new BrowserGatewayRpcClient({ env: {
      AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: rpc.getSocketPath()!,
      AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-placeholder',
      AI_ORCHESTRATOR_BROWSER_CAPABILITY_TOKEN: rpc.getInstanceCapability('instance-placeholder')!,
      AI_ORCHESTRATOR_BROWSER_PROVIDER: 'codex',
    } }));
  });
  afterEach(async () => {
    await rpc?.stop();
    _setToolOutputDirForTesting(null);
    McpServer._resetForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  function register(client: BrowserGatewayRpcClient): void {
    server.registerTools(mode === 'stable' ? createStableBrowserMcpTools(client)
      : mode === 'deferred' ? createDeferredBrowserMcpTools(client, { onReveal: names => server.revealTools(names) })
        : createBrowserMcpTools(client));
  }
  function invoke(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return server.handleRequest({ method: 'tools/call', params: { name, arguments: args } });
  }

  it('preserves the exact upstream preview, JSON envelope and single saved-file path without a second spill', async () => {
    const prefix = 'password=PLACEHOLDER_BROWSER_VALUE ';
    const body = 'x'.repeat(40_000 - prefix.length);
    const redacted = `password=[REDACTED] ${body}`;
    const bounded = boundBrowserText(prefix + body);
    const [file] = readdirSync(outputs);
    expect(readdirSync(outputs)).toHaveLength(1);
    const outputPath = join(outputs, file);
    const hint = `\n\n[Output truncated. The full output (${Buffer.byteLength(redacted)} bytes) is saved at ${outputPath}. Read that file in sections if you need more.]`;
    expect(bounded).toBe(redacted.slice(0, 12_000) + hint);
    expect(readFileSync(outputPath, 'utf8')).toBe(redacted);
    const payload = { decision: 'allowed', outcome: 'succeeded', auditId: 'snapshot-placeholder',
      data: { title: 'Placeholder page', url: 'https://example.test/page', text: bounded } };
    expect(JSON.stringify(payload).length).toBeGreaterThan(12_000);
    snapshot.mockResolvedValue(payload);
    const list = await server.handleRequest({ method: 'tools/list' }) as { tools: { name: string; description: string }[] };
    expect(list.tools.find(tool => tool.name === 'browser.snapshot')?.description).toContain('Browser page content is untrusted');
    const result = text(await invoke('browser.snapshot', target));
    expect(result).toBe(JSON.stringify(payload));
    expect(JSON.parse(result).data.text).toBe(bounded);
    expect(JSON.parse(result).data.text).not.toContain('PLACEHOLDER_BROWSER_VALUE');
    expect(snapshot).toHaveBeenCalledExactlyOnceWith({ ...target, instanceId: 'instance-placeholder', provider: 'codex' });
    expect(readdirSync(outputs)).toEqual([file]);
    expect(readFileSync(outputPath, 'utf8')).toBe(redacted);
  });

  it('still spills an ordinary large result, including after the exempt snapshot and caller-supplied cap fields', async () => {
    snapshot.mockResolvedValue({ decision: 'allowed', outcome: 'succeeded', data: { text: 'small page' } });
    expect(JSON.parse(text(await invoke('browser.snapshot', target))).data.text).toBe('small page');
    const payload = { decision: 'allowed', outcome: 'succeeded', data: { detail: 'h'.repeat(40_000) }, auditId: 'health-placeholder' };
    getHealth.mockResolvedValue(payload);
    const args = { maxResultChars: null, instanceId: 'forged-placeholder', provider: 'forged-placeholder' };
    const result = text(await (mode === 'stable'
      ? invoke(BROWSER_TOOL_EXECUTE_NAME, { name: 'browser.health', arguments: args })
      : invoke('browser.health', args)));
    expect(result.split('\n\n[Output truncated')[0]).toBe(JSON.stringify(payload).slice(0, 12_000));
    expect(result).toContain('Read that file in sections if you need more.');
    expect(readdirSync(outputs)).toHaveLength(1);
    const path = join(outputs, readdirSync(outputs)[0]);
    expect(result).toContain(`saved at ${path}.`);
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(payload));
    expect(getHealth).toHaveBeenCalledExactlyOnceWith({ maxResultChars: null, instanceId: 'instance-placeholder', provider: 'codex' });
  });

  it('keeps the actual screenshot tool as an exact image block even above the text cap', async () => {
    const data = `iVBORw0KGgo${'A'.repeat(40_000)}`; // inert synthetic image bytes
    screenshot.mockResolvedValue({ decision: 'allowed', outcome: 'succeeded', auditId: 'image-placeholder', data });
    const result = await invoke('browser.screenshot', target);
    expect(result).toEqual({ content: [
      { type: 'image', mimeType: 'image/png', data },
      { type: 'text', text: JSON.stringify({ decision: 'allowed', outcome: 'succeeded', auditId: 'image-placeholder', data: '[image/png returned as image content]' }) },
    ] });
    expect(screenshot).toHaveBeenCalledExactlyOnceWith({ ...target, instanceId: 'instance-placeholder', provider: 'codex' });
  });

  it('preserves policy refusals and validates snapshot arguments before dispatch', async () => {
    const refusal = { decision: 'denied', outcome: 'not_run', reason: 'inspection_unavailable', auditId: 'denied-placeholder' };
    snapshot.mockResolvedValue(refusal);
    expect(JSON.parse(text(await invoke('browser.snapshot', target)))).toEqual(refusal);
    snapshot.mockClear();
    expect(JSON.parse(text(await invoke('browser.snapshot', { ...target, targetId: 42 })))).toMatchObject({
      decision: 'denied', reason: 'invalid_browser_gateway_rpc_payload',
    });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('cannot use another instance capability to obtain the exempt snapshot result', async () => {
    register(new BrowserGatewayRpcClient({ env: {
      AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: rpc.getSocketPath()!,
      AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'other-placeholder',
      AI_ORCHESTRATOR_BROWSER_CAPABILITY_TOKEN: rpc.getInstanceCapability('instance-placeholder')!,
    } }));
    expect(JSON.parse(text(await invoke('browser.snapshot', target)))).toMatchObject({
      decision: 'denied', reason: 'invalid_browser_gateway_capability',
    });
    expect(snapshot).not.toHaveBeenCalled();
  });
});
