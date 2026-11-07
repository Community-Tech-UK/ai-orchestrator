import type { ContextAssemblyResult } from './context-engine';
import type { RlmContextInfo, UnifiedMemoryContextInfo } from '../instance/instance-types';
import type { IndexedCodebaseContextInfo } from '../indexing/indexed-codebase-context';
import { estimateTokens } from '../../shared/utils/token-estimate';
import { TurnInjectionPolicy } from './turn-injection-policy';

/** Filter at item boundaries; retain original labels and never reinterpret recalled content. */
export function filterTurnContext(policy: TurnInjectionPolicy, result: ContextAssemblyResult): ContextAssemblyResult {
  return { ...result, rlmContext: filterRlm(policy, result.rlmContext),
    unifiedMemoryContext: filterMemory(policy, result.unifiedMemoryContext), indexedCodebaseContext: filterCode(policy, result.indexedCodebaseContext) };
}
function filterRlm(policy: TurnInjectionPolicy, context: RlmContextInfo | null): RlmContextInfo | null {
  if (!context) return null;
  const parts = context.context.split(/\n\n---\n\n(?=\[Match \d+\])/);
  if (parts.length !== context.sectionsAccessed.length) return policy.take(context.sectionsAccessed.map(id => `rlm:${id}`), context.tokens) ? context : null;
  const ids: string[] = [];
  const kept = parts.filter((text, i) => {
    if (!policy.take([`rlm:${context.sectionsAccessed[i]}`], estimateTokens(text + '\n\n---\n\n'))) return false;
    ids.push(context.sectionsAccessed[i]); return true;
  });
  if (!kept.length) return null;
  const text = kept.join('\n\n---\n\n');
  return { ...context, context: text, tokens: estimateTokens(text), sectionsAccessed: ids };
}
function filterMemory(policy: TurnInjectionPolicy, context: UnifiedMemoryContextInfo | null): UnifiedMemoryContextInfo | null {
  if (!context) return null;
  const blocks = context.context.split(/(?=^(?:Wake Context|Activated Skill Instructions|Procedural Memory|Long-term Memory):$)/m).filter(Boolean);
  let longTermCount = 0, proceduralCount = 0, skillCount = 0;
  const kept: string[] = [];
  for (const block of blocks) {
    const split = block.indexOf('\n');
    const heading = split < 0 ? '' : block.slice(0, split);
    const body = split < 0 ? block : block.slice(split + 1);
    const items = /^(?:Procedural|Long-term) Memory:$/.test(heading) ? body.split(/(?=^- )/m).filter(text => text.trim()) : [body];
    const accepted = items.filter(text => policy.take([`memory:${heading}:${text.trim()}`], estimateTokens((heading ? heading + '\n' : '') + text)));
    if (!accepted.length) continue;
    if (heading === 'Long-term Memory:') longTermCount += accepted.length;
    if (heading === 'Procedural Memory:') proceduralCount += accepted.length;
    if (heading === 'Activated Skill Instructions:') skillCount += context.skillCount ?? 0;
    kept.push((heading ? heading + '\n' : '') + accepted.join(''));
  }
  if (!kept.length) return null;
  const text = kept.join('\n').trim();
  return { ...context, context: text, tokens: estimateTokens(text), longTermCount, proceduralCount, skillCount };
}
function filterCode(policy: TurnInjectionPolicy, context: IndexedCodebaseContextInfo | null): IndexedCodebaseContextInfo | null {
  if (!context) return null;
  // Use already budget-trimmed text; raw results can include chunks omitted by the service.
  const parts = context.context.split(/\n\n(?=- .+ \((?:exact|bm25|vector|hybrid), score )/);
  if (parts.length > context.results.length || parts.some((part, i) => !part.startsWith(`- ${context.results[i].relativePath}`))) {
    return policy.take(context.results.map(item => `code:${item.filePath}:${item.startLine}`), context.tokens) ? context : null;
  }
  const results: IndexedCodebaseContextInfo['results'] = [];
  const kept = parts.filter((part, i) => {
    const item = context.results[i];
    if (!policy.take([`code:${item.filePath}:${item.startLine}`], estimateTokens(part + '\n\n'))) return false;
    results.push(item); return true;
  });
  if (!kept.length) return null;
  if (kept.length === parts.length) return context;
  const text = kept.join('\n\n');
  return { ...context, context: text, tokens: estimateTokens(text), results };
}
