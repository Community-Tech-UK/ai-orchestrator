import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../shared/utils/token-estimate';
import type { OutputMessage } from '../../shared/types/instance.types';
import {
  computeContextAttribution,
  type ContextAttributionDeps,
  type ContextAttributionInput,
} from './context-attribution-service';

function message(overrides: Partial<OutputMessage> & Pick<OutputMessage, 'type' | 'content'>): OutputMessage {
  return {
    id: `m-${Math.abs(overrides.content.length)}-${overrides.type}`,
    timestamp: 1,
    ...overrides,
  };
}

const TOOL = {
  name: 'x.tool',
  description: 'A tool.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({}),
};

function makeDeps(overrides: Partial<ContextAttributionDeps> = {}): ContextAttributionDeps {
  return {
    resolveInstructionStack: async () => ({
      sources: [
        { path: '/proj/CLAUDE.md', loaded: true, applied: true },
        { path: '/proj/SKIPPED.md', loaded: true, applied: false },
        { path: '/proj/missing.md', loaded: false, applied: false },
      ],
    }),
    readFile: async (path) => (path === '/proj/CLAUDE.md' ? 'a'.repeat(400) : ''),
    createBrowserTools: () => [TOOL, TOOL],
    createDeferredBrowserTools: () => [TOOL],
    createOrchestratorTools: () => [TOOL],
    createCodememTools: () => [TOOL],
    createComputerUseTools: () => [TOOL],
    ...overrides,
  };
}

function makeInput(overrides: Partial<ContextAttributionInput['instance']> = {}): ContextAttributionInput {
  return {
    instance: {
      id: 'inst-1',
      workingDirectory: '/proj',
      outputBuffer: [],
      contextUsage: { used: 0, total: 200_000, percentage: 0 },
      ...overrides,
    },
    mcpProfile: {
      browserGateway: 'eager',
      orchestratorTools: true,
      codemem: false,
      computerUse: false,
    },
  };
}

function bucket(report: Awaited<ReturnType<typeof computeContextAttribution>>, key: string) {
  return report.buckets.find((candidate) => candidate.key === key);
}

describe('computeContextAttribution', () => {
  it('attributes applied instruction files only, with per-file detail', async () => {
    const report = await computeContextAttribution(makeInput(), makeDeps());
    const instructions = bucket(report, 'instructionFiles')!;
    expect(instructions.tokens).toBe(estimateTokens('a'.repeat(400)));
    expect(instructions.detail).toEqual([
      { label: '/proj/CLAUDE.md', tokens: estimateTokens('a'.repeat(400)) },
    ]);
  });

  it('measures only the injected MCP servers, honouring browser deferral', async () => {
    const eager = await computeContextAttribution(makeInput(), makeDeps());
    const eagerBucket = bucket(eager, 'mcpToolSchemas')!;
    expect(eagerBucket.detail!.map((d) => d.label).sort()).toEqual([
      'browser-gateway',
      'orchestrator-tools',
    ]);

    const deferredInput = makeInput();
    deferredInput.mcpProfile = { ...deferredInput.mcpProfile, browserGateway: 'deferred' };
    const deferred = await computeContextAttribution(deferredInput, makeDeps());
    const deferredBucket = bucket(deferred, 'mcpToolSchemas')!;
    expect(deferredBucket.detail!.map((d) => d.label)).toContain('browser-gateway (deferred)');
    // Deferred surface (1 stub tool) is cheaper than eager (2 stub tools).
    expect(deferredBucket.tokens).toBeLessThan(eagerBucket.tokens);
  });

  it('splits conversation, tool traffic, and attachments by message kind', async () => {
    const chat = 'hello world '.repeat(20);
    const toolOut = 'tool output '.repeat(50);
    const input = makeInput({
      outputBuffer: [
        message({ type: 'assistant', content: chat }),
        message({ type: 'user', content: chat }),
        message({ type: 'tool_result', content: toolOut }),
        message({
          type: 'user',
          content: '',
          attachments: [{ name: 'shot.png', type: 'image/png', size: 5, data: 'data:image/png;base64,AAAA' }],
        }),
      ],
    });
    const report = await computeContextAttribution(input, makeDeps());
    expect(bucket(report, 'conversationHistory')!.tokens).toBe(2 * estimateTokens(chat));
    expect(bucket(report, 'toolResults')!.tokens).toBe(estimateTokens(toolOut));
    expect(bucket(report, 'attachments')!.tokens).toBe(estimateTokens('', { imageCount: 1 }));
  });

  it('adds an `other` remainder only when the aggregate is known, never negative', async () => {
    const noAggregate = await computeContextAttribution(makeInput(), makeDeps());
    expect(bucket(noAggregate, 'other')).toBeUndefined();
    expect(noAggregate.aggregateUsed).toBeUndefined();

    const withAggregate = await computeContextAttribution(
      makeInput({ contextUsage: { used: 50_000, total: 200_000, percentage: 25, isEstimated: true } }),
      makeDeps(),
    );
    const known = withAggregate.buckets
      .filter((candidate) => candidate.key !== 'other')
      .reduce((total, candidate) => total + candidate.tokens, 0);
    expect(bucket(withAggregate, 'other')!.tokens).toBe(50_000 - known);
    expect(withAggregate.aggregateUsed).toBe(50_000);
    expect(withAggregate.aggregateIsEstimated).toBe(true);

    const overrun = await computeContextAttribution(
      makeInput({ contextUsage: { used: 1, total: 200_000, percentage: 0 } }),
      makeDeps(),
    );
    expect(bucket(overrun, 'other')!.tokens).toBe(0);
  });

  it('survives an instruction-resolver failure and still reports the rest', async () => {
    const report = await computeContextAttribution(
      makeInput(),
      makeDeps({
        resolveInstructionStack: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(bucket(report, 'instructionFiles')!.tokens).toBe(0);
    expect(bucket(report, 'mcpToolSchemas')!.tokens).toBeGreaterThan(0);
  });
});
