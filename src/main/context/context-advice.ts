import { machineSessionReasonOf } from '../../shared/utils/machine-session';
import { autoCompactNotice } from '../../shared/utils/auto-compact-notice';
import type { ContextAdvice, ProviderMeasuredContext } from '../../shared/types/provider-measured-context.types';
import type { ContextAttributionReport } from '../../shared/types/context-attribution.types';
interface AdviceInput { totalTokens: number; maxTokens?: number; autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean; toolResultTokens?: number; topTools?: ProviderMeasuredContext['topTools']; categories: { name: string; tokens: number }[] }
export function contextAdviceEstimate(report: ContextAttributionReport): AdviceInput {
  return { totalTokens: report.aggregateUsed ?? report.buckets.reduce((sum, b) => sum + b.tokens, 0),
    maxTokens: report.aggregateTotal, toolResultTokens: report.buckets.find(b => b.key === 'toolResults')?.tokens,
    categories: report.buckets.map(b => ({ name: b.key === 'instructionFiles' ? 'Instructions' : b.key === 'mcpToolSchemas' ? 'Connector tools' : b.key, tokens: b.tokens })) };
}
export function buildContextAdvice(input: AdviceInput, facts: { instance?: { parentId?: string | null; metadata?: Record<string, unknown> };
  cacheRewrite?: { cause: string; missedTokens: number; extraCostUsd?: number }; showCost?: boolean } = {}): ContextAdvice[] {
  if (machineSessionReasonOf(facts.instance)) return [];
  const advice: ContextAdvice[] = [];
  const output = input.toolResultTokens ?? 0;
  if (output >= 10000 && output >= input.totalTokens * 0.15) advice.push({ id: 'tool-output', level: 'act', tokens: output,
    text: `Tool output is ${Math.round(output / input.totalTokens * 100)}% of this conversation (${Math.round(output / 1000)}K tokens)${input.topTools?.[0] ? `, mostly ${input.topTools[0].name}` : ''}. Compact now to drop old output.`, action: 'compact-now' });
  if (input.autoCompactThreshold && input.isAutoCompactEnabled !== false && input.totalTokens >= input.autoCompactThreshold * 0.8) {
    advice.push({ id: 'summary-point', level: 'act', text: autoCompactNotice(input.totalTokens, input.autoCompactThreshold), action: 'compact-now' });
  }
  const setup = input.categories.filter(c => /instruction|system.prompt|skill|memory|connector|mcp|tool.schema/i.test(c.name)).reduce((sum, c) => sum + c.tokens, 0);
  if (setup > 0) advice.push({ id: 'setup', level: 'info', tokens: setup,
    text: `Your instructions, skills and connector tools add about ${Math.round(setup / 1000)}K tokens to every session. They are cached after the first reply.` });
  if (facts.cacheRewrite) advice.push({ id: 'cache', level: 'info', tokens: facts.cacheRewrite.missedTokens,
    text: `Last re-send: ${facts.cacheRewrite.cause} · ${Math.round(facts.cacheRewrite.missedTokens / 1000)}K tokens${facts.showCost && facts.cacheRewrite.extraCostUsd !== undefined ? ` (≈$${facts.cacheRewrite.extraCostUsd.toFixed(2)} API-price equivalent)` : ''}.` });
  return advice;
}
