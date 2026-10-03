import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { classifyTurnEnding } from '../cli/turn-ending-classifier';
import { hasCollapsedReasoning, isCollapsedReasoning, readReasoningBlocks } from '../cli/adapters/reasoning-collapse';
import { readTurnToolObservation } from './adapter-turn-tool-observation';
import { createHash } from 'node:crypto';
import { logProviderTurnCompletion, type TurnEndingDiagnosticContext } from './provider-turn-ending-diagnostics';

const MAX_THINKING_BLOCKS = 64;
const MAX_THINKING_CHARS_PER_BLOCK = 4_000;
const MAX_TRACKED_TOOLS = 256;

/** Turn-scoped evidence from all adapter transports. Never persists source material. */
export class AdapterTurnEndingObservation {
  constructor(private readonly diagnosticContext: () => TurnEndingDiagnosticContext = () => ({})) {}
  private readonly thinking = new Map<string, { content: string }>();
  private readonly openTools = new Set<string>();
  private readonly backgroundTools = new Set<string>();
  private readonly assistantSnapshots = new Map<string, string>();
  private unansweredToolResult = false;
  private cancelled = false;
  private lastToolReadLike = false;
  private providerRetrying = false;
  private active = false;
  private reasoningCollapsed = false;
  private doomLoopBlocked = false;
  private lastToolName = '';

  private fingerprint(content: string): string {
    return `${content.length}:${createHash('sha256').update(content).digest('hex')}`;
  }

  enrich(event: ProviderRuntimeEvent, raw: unknown): ProviderRuntimeEvent {
    if (event.kind === 'status' && ['busy', 'processing', 'working', 'streaming'].includes(event.status)) {
      if (!this.active) this.clear();
      this.active = true;
    }
    if (event.kind === 'status' && ['interrupting', 'interrupted'].includes(event.status)) this.cancelled = true;
    const tool = readTurnToolObservation(event);
    if (tool?.kind === 'tool_use') {
      this.active = true;
      if (tool.toolName !== this.lastToolName) this.doomLoopBlocked = false;
      this.lastToolName = tool.toolName;
      if (tool.toolUseId) {
        const rawInput = tool.input?.['rawInput'] as Record<string, unknown> | undefined;
        const background = tool.input?.['background'] === true || tool.input?.['run_in_background'] === true || rawInput?.['background'] === true;
        (background ? this.backgroundTools : this.openTools).add(tool.toolUseId);
        if (this.openTools.size > MAX_TRACKED_TOOLS) this.openTools.delete(this.openTools.values().next().value as string);
        if (this.backgroundTools.size > MAX_TRACKED_TOOLS) this.backgroundTools.delete(this.backgroundTools.values().next().value as string);
      }
      this.lastToolReadLike = tool.input?.['kind'] === 'read' || /^(?:read|read file|read_file|readfile)$/i.test(tool.toolName);
    }
    if (tool?.kind === 'tool_result' && tool.toolUseId) {
      if (this.openTools.delete(tool.toolUseId)) this.unansweredToolResult = true;
      this.backgroundTools.delete(tool.toolUseId);
    }
    if (event.kind === 'output') {
      if (event.messageType === 'assistant') {
        this.active = true;
        if (event.content.trim()) {
          const fingerprint = this.fingerprint(event.content);
          const id = event.messageId ?? 'assistant';
          if (event.metadata?.['accumulatedContent'] === undefined || this.assistantSnapshots.get(id) !== fingerprint) {
            this.unansweredToolResult = false;
            this.doomLoopBlocked = false;
          }
          this.assistantSnapshots.set(id, fingerprint);
          if (this.assistantSnapshots.size > MAX_THINKING_BLOCKS) this.assistantSnapshots.delete(this.assistantSnapshots.keys().next().value as string);
        }
        for (const [index, block] of readReasoningBlocks(event.thinking).entries()) {
          this.reasoningCollapsed ||= isCollapsedReasoning(block.content);
          this.thinking.set(block.id ?? `${event.messageId}:${index}`, { content: block.content.slice(-MAX_THINKING_CHARS_PER_BLOCK) });
          if (this.thinking.size > MAX_THINKING_BLOCKS) this.thinking.delete(this.thinking.keys().next().value as string);
        }
        this.reasoningCollapsed ||= hasCollapsedReasoning([...this.thinking.values()]);
      }
      if (event.metadata?.['source'] === 'acp-retry-state') this.providerRetrying = event.metadata['phase'] === 'retrying';
      if (typeof event.metadata?.['willRetry'] === 'boolean') this.providerRetrying = event.metadata['willRetry'];
      if (event.metadata?.['doomLoopBlocked'] === true) { this.doomLoopBlocked = true; this.active = true; }
      if (event.metadata?.['threadCompacted'] === true) { this.thinking.clear(); this.reasoningCollapsed = false; }
    }
    if (event.kind === 'exit') {
      const turnEnding = event.code === 0 && !event.signal && this.active && (this.unansweredToolResult || this.doomLoopBlocked) && this.openTools.size === 0 && !this.cancelled && !this.providerRetrying
        ? classifyTurnEnding({ kind: 'complete', metadata: { danglingToolResult: true, toolResultAwaitingReply: true, doomLoop: this.doomLoopBlocked } }) : event.turnEnding;
      this.clear();
      return turnEnding ? { ...event, turnEnding } : event;
    }
    if (event.kind !== 'complete' && event.kind !== 'error') return event;
    if (event.kind === 'error' && (raw as { willRetry?: boolean })?.willRetry === false) this.providerRetrying = false;
    const response = raw as CliResponse & { thinking?: { content: string }[] };
    // Nonstreaming adapters may first deliver their final answer in complete.
    // A repeated narration snapshot remains evidence of an unanswered result.
    if (event.kind === 'complete' && response?.content?.trim() && ![...this.assistantSnapshots.values()].includes(this.fingerprint(response.content))) {
      this.unansweredToolResult = false;
      this.doomLoopBlocked = false;
    }
    const classified = classifyTurnEnding({
      kind: event.kind,
      ...(event.kind === 'complete' ? {
        text: response.content,
        metadata: { ...response.metadata, ...(event.stopReason ? { stopReason: event.stopReason } : {}), ...(event.finish ? { finish: event.finish } : {}), ...(this.unansweredToolResult ? { danglingToolResult: true, toolResultAwaitingReply: true } : {}), ...(this.doomLoopBlocked ? { doomLoop: true } : {}), ...(this.reasoningCollapsed ? { reasoningCollapsed: true } : {}), ...(this.providerRetrying ? { providerRetrying: true } : {}) },
        raw: response.raw,
        outputTokens: response.usage?.isEstimated ? undefined : response.usage?.outputTokens ?? event.outputTokens,
        reasoningTokens: response.usage?.reasoningTokens ?? event.reasoningTokens,
        cancelled: response.degradedReason === 'cancelled' || this.cancelled,
      } : { error: raw, metadata: { ...raw as Record<string, unknown>, ...(this.providerRetrying ? { providerRetrying: true } : {}) } }),
      thinking: [...this.thinking.values(), ...readReasoningBlocks(response?.thinking)],
      hasOpenToolCall: this.openTools.size > 0,
      lastToolReadLike: this.lastToolReadLike,
    });
    const turnEnding = ['unknown_error', 'completed'].includes(classified.reason) && event.turnEnding && event.turnEnding.reason !== 'completed'
      ? { ...event.turnEnding, ...(classified.autoContinueSuppressed ? { autoContinueSuppressed: true } : {}), ...(classified.providerRetrying ? { providerRetrying: true } : {}) }
      : classified;
    const enriched = { ...event, turnEnding };
    if (enriched.kind === 'complete' && event.kind === 'complete') logProviderTurnCompletion(event, enriched, this.diagnosticContext(), [...this.thinking.values(), ...readReasoningBlocks(response?.thinking)], this.openTools.size ? this.lastToolReadLike ? 'read' : 'other' : undefined);
    if (event.kind === 'complete' || !turnEnding.providerRetrying) this.clear();
    return enriched;
  }

  private clear(): void {
    this.thinking.clear();
    this.openTools.clear();
    this.backgroundTools.clear();
    this.assistantSnapshots.clear();
    this.unansweredToolResult = false;
    this.cancelled = false;
    this.lastToolReadLike = false;
    this.providerRetrying = false;
    this.active = false;
    this.reasoningCollapsed = false;
    this.doomLoopBlocked = false;
    this.lastToolName = '';
  }
}
