/**
 * WS8 context attribution — "what is consuming this instance's context
 * window, by source".
 *
 * Computes an on-demand per-instance breakdown using the SAME char-heuristic
 * estimator family the compactor uses (`shared/utils/token-estimate`), so the
 * panel and the compaction machinery agree. Values are estimates and are
 * labelled as such in the UI; the provider-owned system prompt is not
 * observable from AIO and is left inside the `other` remainder, which is only
 * reported when the aggregate occupancy is known (never fabricated).
 *
 * Read-only observability: computed on demand from data AIO already holds
 * (instruction stack, injected MCP tool tables, the instance output buffer).
 * Nothing here changes what is sent to any provider.
 */

import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type {
  ContextAttributionBucket,
  ContextAttributionDetail,
  ContextAttributionReport,
} from '../../shared/types/context-attribution.types';
import { estimateTokens } from '../../shared/utils/token-estimate';
import type { McpServerToolDefinition } from '../mcp/mcp-server-tools';
import { getLogger } from '../logging/logger';

const logger = getLogger('ContextAttribution');

const DETAIL_LIMIT = 6;

/** Which MCP tool groups are injected for this instance (handler-derived). */
export interface McpInjectionProfile {
  /** 'off' when no browser gateway is injected (e.g. remote instance). */
  browserGateway: 'eager' | 'deferred' | 'off';
  orchestratorTools: boolean;
  codemem: boolean;
  computerUse: boolean;
}

export interface ContextAttributionInput {
  instance: Pick<
    Instance,
    'id' | 'workingDirectory' | 'outputBuffer' | 'contextUsage'
  >;
  mcpProfile: McpInjectionProfile;
}

interface InstructionStackLike {
  sources: Array<{ path: string; loaded: boolean; applied: boolean }>;
}

export interface ContextAttributionDeps {
  resolveInstructionStack(params: { workingDirectory: string }): Promise<InstructionStackLike>;
  readFile(path: string): Promise<string>;
  createBrowserTools(): McpServerToolDefinition[];
  createDeferredBrowserTools(): McpServerToolDefinition[];
  createOrchestratorTools(): McpServerToolDefinition[];
  createCodememTools(): McpServerToolDefinition[];
  createComputerUseTools(): McpServerToolDefinition[];
}

function defaultDeps(): ContextAttributionDeps {
  /* eslint-disable @typescript-eslint/no-require-imports */
  // Lazy requires keep this module import-light; the heavy tool tables load
  // only when the panel is actually opened.
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  const resolver = require('../core/config/instruction-resolver') as typeof import('../core/config/instruction-resolver');
  const browser = require('../browser-gateway/browser-mcp-tools') as typeof import('../browser-gateway/browser-mcp-tools');
  const deferral = require('../browser-gateway/browser-mcp-deferral') as typeof import('../browser-gateway/browser-mcp-deferral');
  const orchestrator = require('../mcp/orchestrator-tools-mcp-forwarder') as typeof import('../mcp/orchestrator-tools-mcp-forwarder');
  const codemem = require('../codemem/codemem-mcp-forwarder') as typeof import('../codemem/codemem-mcp-forwarder');
  const desktop = require('../desktop-gateway/desktop-mcp-tools') as typeof import('../desktop-gateway/desktop-mcp-tools');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const noopClient = { call: async () => ({}) };
  return {
    resolveInstructionStack: (params) => resolver.resolveInstructionStack(params),
    readFile: (filePath) => fs.readFile(filePath, 'utf-8'),
    createBrowserTools: () => browser.createBrowserMcpTools(noopClient),
    createDeferredBrowserTools: () =>
      deferral
        .createDeferredBrowserMcpTools(noopClient, { onReveal: () => {} })
        .filter((tool) => !tool.hidden),
    createOrchestratorTools: () => orchestrator.createOrchestratorToolsForwarderTools(noopClient),
    createCodememTools: () => codemem.createCodememForwarderTools(noopClient),
    createComputerUseTools: () => desktop.createDesktopMcpTools(noopClient),
  };
}

/** Tokens a tool table costs the client, per the estimator's JSON ratio. */
function estimateToolSchemaTokens(tools: readonly McpServerToolDefinition[]): number {
  return tools.reduce(
    (total, tool) =>
      total
      + estimateTokens(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
        { contentKind: 'json' },
      ),
    0,
  );
}

function estimateMessageTokens(message: OutputMessage): number {
  let tokens = estimateTokens(message.content);
  for (const thinking of message.thinking ?? []) {
    tokens += estimateTokens(thinking.content);
  }
  return tokens;
}

function estimateAttachmentTokens(message: OutputMessage): number {
  let tokens = 0;
  for (const attachment of message.attachments ?? []) {
    if (attachment.type.startsWith('image/')) {
      tokens += estimateTokens('', { imageCount: 1 });
    } else {
      // Non-image attachments reach the provider as text; the data URL is
      // base64 (~4/3 inflation), so estimate on the decoded size.
      tokens += estimateTokens('x'.repeat(Math.ceil(attachment.data.length * 0.75)));
    }
  }
  return tokens;
}

function sortedDetail(entries: ContextAttributionDetail[]): ContextAttributionDetail[] {
  return [...entries]
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, DETAIL_LIMIT);
}

export async function computeContextAttribution(
  input: ContextAttributionInput,
  deps: ContextAttributionDeps = defaultDeps(),
): Promise<ContextAttributionReport> {
  const { instance, mcpProfile } = input;

  // --- Instruction files -------------------------------------------------
  const instructionDetail: ContextAttributionDetail[] = [];
  let instructionTokens = 0;
  try {
    const stack = await deps.resolveInstructionStack({
      workingDirectory: instance.workingDirectory,
    });
    for (const source of stack.sources) {
      if (!source.loaded || !source.applied) continue;
      try {
        const content = await deps.readFile(source.path);
        const tokens = estimateTokens(content);
        instructionTokens += tokens;
        instructionDetail.push({ label: source.path, tokens });
      } catch {
        // Unreadable file — it cannot be occupying context either.
      }
    }
  } catch (error) {
    logger.warn('Instruction stack resolution failed for attribution', {
      instanceId: instance.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // --- MCP tool schemas ----------------------------------------------------
  const mcpDetail: ContextAttributionDetail[] = [];
  let mcpTokens = 0;
  const addServer = (label: string, create: () => McpServerToolDefinition[]): void => {
    try {
      const tokens = estimateToolSchemaTokens(create());
      mcpTokens += tokens;
      mcpDetail.push({ label, tokens });
    } catch (error) {
      logger.warn('MCP schema measurement failed for attribution', {
        instanceId: instance.id,
        server: label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  if (mcpProfile.browserGateway === 'eager') {
    addServer('browser-gateway', deps.createBrowserTools);
  } else if (mcpProfile.browserGateway === 'deferred') {
    addServer('browser-gateway (deferred)', deps.createDeferredBrowserTools);
  }
  if (mcpProfile.orchestratorTools) addServer('orchestrator-tools', deps.createOrchestratorTools);
  if (mcpProfile.codemem) addServer('codemem', deps.createCodememTools);
  if (mcpProfile.computerUse) addServer('computer-use', deps.createComputerUseTools);

  // --- Conversation, tool results, attachments -----------------------------
  let conversationTokens = 0;
  let toolTokens = 0;
  let attachmentTokens = 0;
  for (const message of instance.outputBuffer) {
    attachmentTokens += estimateAttachmentTokens(message);
    if (message.type === 'tool_use' || message.type === 'tool_result') {
      toolTokens += estimateMessageTokens(message);
    } else if (message.type === 'assistant' || message.type === 'user' || message.type === 'system') {
      conversationTokens += estimateMessageTokens(message);
    }
  }

  const buckets: ContextAttributionBucket[] = [
    { key: 'instructionFiles', tokens: instructionTokens, detail: sortedDetail(instructionDetail) },
    { key: 'mcpToolSchemas', tokens: mcpTokens, detail: sortedDetail(mcpDetail) },
    { key: 'conversationHistory', tokens: conversationTokens },
    { key: 'toolResults', tokens: toolTokens },
    { key: 'attachments', tokens: attachmentTokens },
  ];

  const aggregateUsed = instance.contextUsage?.used;
  const report: ContextAttributionReport = {
    instanceId: instance.id,
    computedAt: Date.now(),
    buckets,
  };
  if (typeof aggregateUsed === 'number' && aggregateUsed > 0) {
    const known = buckets.reduce((total, bucket) => total + bucket.tokens, 0);
    buckets.push({ key: 'other', tokens: Math.max(0, aggregateUsed - known) });
    report.aggregateUsed = aggregateUsed;
    report.aggregateTotal = instance.contextUsage.total;
    report.aggregateIsEstimated = instance.contextUsage.isEstimated === true;
  }
  return report;
}
