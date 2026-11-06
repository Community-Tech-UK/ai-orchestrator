import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from './mcp-server';
import { createOrchestratorEvidenceToolDefinitions } from './orchestrator-evidence-tools';
import { createStableOrchestratorTools, ORCHESTRATOR_TOOL_EXECUTE_NAME } from './orchestrator-mcp-stable-tools';
import { createDeferredOrchestratorTools } from './orchestrator-mcp-deferral';
import { _setToolOutputDirForTesting } from '../util/tool-output-truncation';
import { boundedEvidenceText, wrapUntrustedEvidence, calculateEvidenceRangeTokenBudget, validateEvidenceRange } from '../context-evidence/evidence-retrieval-limits';
import { resolveOrchestratorForwarderTools } from './orchestrator-tools-mcp-forwarder-runtime';
import { ORCHESTRATOR_TOOL_STABLE_ENV } from './orchestrator-mcp-stable-tools';

describe('stable evidence output policy at the MCP serialization boundary', () => {
  it('preserves bounded evidence in every mode while ordinary stable results still spill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stable-evidence-')); _setToolOutputDirForTesting(dir);
    try {
      const tokenLimit = calculateEvidenceRangeTokenBudget(1_000_000);
      validateEvidenceRange(0, 13_000, 13_000);
      const text = boundedEvidenceText('x'.repeat(13_000), tokenLimit, value => Math.ceil(value.length / 4));
      const payload = { content: wrapUntrustedEvidence('evidence-placeholder', text),
        citation: 'evidence-placeholder:0-13000', startByte: 0, endByte: 13_000 };
      expect(JSON.stringify(payload).length).toBeGreaterThan(12_000);
      const read = vi.fn(async () => payload);
      const context = { instanceId: 'instance-placeholder', conversationId: 'conversation-placeholder',
        coordinator: { read, list: read, search: read, compare: read, verify: read } };
      for (const mode of ['eager', 'deferred', 'stable']) {
        McpServer._resetForTesting(); const server = McpServer.getInstance();
        const all = [...createOrchestratorEvidenceToolDefinitions(context),
          { name: 'ordinary', description: '', inputSchema: {}, handler: read }];
        server.registerTools(mode === 'stable' ? createStableOrchestratorTools(all)
          : mode === 'deferred' ? createDeferredOrchestratorTools(all, { onReveal: names => server.revealTools(names) }) : all);
        const args = { evidenceId: 'evidence-placeholder', startByte: 0, endByte: 13_000, tokenLimit: 4096 };
        const result = await server.handleRequest({ method: 'tools/call', params: mode === 'stable'
          ? { name: ORCHESTRATOR_TOOL_EXECUTE_NAME, arguments: { name: 'evidence_read', arguments: args } }
          : { name: 'evidence_read', arguments: args } }) as { content: { text: string }[] };
        expect(result.content[0].text).toBe(JSON.stringify(payload));
        expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: context.conversationId,
          requester: expect.objectContaining({ localSensitiveAuthorized: false, localRestrictedAuthorized: false }) }));
        if (mode === 'stable') {
          await expect(server.handleRequest({ method: 'tools/call', params: { name: ORCHESTRATOR_TOOL_EXECUTE_NAME,
            arguments: { name: 'evidence_read', arguments: { ...args, conversationId: 'other' } } } })).rejects.toThrow();
          const ordinary = await server.handleRequest({ method: 'tools/call', params: { name: ORCHESTRATOR_TOOL_EXECUTE_NAME,
            arguments: { name: 'ordinary', arguments: { maxResultChars: null } } } }) as { content: { text: string }[] };
          expect(ordinary.content[0].text).toContain('saved at');
          expect(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')).toBe(JSON.stringify(payload));
          const denied = new McpServer();
          denied.registerTools(createStableOrchestratorTools(createOrchestratorEvidenceToolDefinitions({ ...context, conversationId: null })));
          await expect(denied.handleRequest({ method: 'tools/call', params: { name: ORCHESTRATOR_TOOL_EXECUTE_NAME,
            arguments: { name: 'evidence_read', arguments: args } } })).rejects.toThrow('EVIDENCE_CONVERSATION_UNRESOLVED');
        }
      }
      vi.stubEnv(ORCHESTRATOR_TOOL_STABLE_ENV, '1');
      const rpc = { call: vi.fn(async () => payload) };
      const forwarded = new McpServer();
      forwarded.registerTools(resolveOrchestratorForwarderTools(rpc, () => undefined));
      const args = { evidenceId: 'evidence-placeholder', startByte: 0, endByte: 13_000, tokenLimit };
      const result = await forwarded.handleRequest({ method: 'tools/call', params: { name: ORCHESTRATOR_TOOL_EXECUTE_NAME,
        arguments: { name: 'evidence_read', arguments: args } } }) as { content: { text: string }[] };
      expect(result.content[0].text).toBe(JSON.stringify(payload));
      expect(rpc.call).toHaveBeenCalledExactlyOnceWith('orchestrator_tools.evidence_read', args);
    } finally { vi.unstubAllEnvs(); _setToolOutputDirForTesting(null); rmSync(dir, { recursive: true, force: true }); McpServer._resetForTesting(); }
  });
});
