/** Conservative word checks for choices that always require human authority. */
import type { LoopOutstandingItem } from '../types/loop-outstanding.types';
export type QuestionRiskClass = 'scope' | 'money' | 'deletion' | 'shared';

const RISK_PATTERNS: Readonly<Record<QuestionRiskClass, readonly RegExp[]>> = {
  scope: [
    /\b(?:out of scope|descope|public API|breaking change|schema change|new migration|new feature)\b/i,
    /\b(?:defer|skip|drop)\b(?:\W+\w+){0,4}\W+(?:items?|tasks?|requirements?|criteri(?:a|on)|phases?|features?)\b/i,
    /\b(?:change|modify|amend)\b(?:\W+\w+){0,4}\W+(?:goal|spec|plan|requirements?|acceptance criteria)\b/i,
    /\b(?:add|install)\b(?:\W+\w+){0,4}\W+(?:dependenc(?:y|ies)|packages?|librar(?:y|ies))\b/i,
  ],
  money: [
    /\b(?:pay|purchase|buy|subscribe|top up|add credits|billing|invoice|paid (?:plan|tier|API|service|model))\b/i,
    /\b(?:upgrade|downgrade)\b(?:\W+\w+){0,4}\W+(?:plan|tier)\b/i,
    /\b(?:provision|resize)\b(?:\W+\w+){0,4}\W+server\b/i,
    /(?:[$£€]\s*\d|\b\d+(?:\.\d+)?\s*(?:USD|GBP|EUR)\b)/i,
    /\b(?:raise|increase)\b.{0,70}\b(?:spend|cost|budget)\b.{0,30}\b(?:cap|limit)\b/i,
  ],
  deletion: [
    /\b(?:delete|remove|drop|purge|wipe|erase|truncate|overwrite|discard|prune)\b(?:\W+\w+){0,4}\W+(?:data|databases?|tables?|records?|files?|folders?|branches|branch|tags?|history|commits?|backups?|logs?|accounts?|sessions?|worktrees?|migrations?|settings?)\b/i,
    /\b(?:rm\s+-rf|git\s+reset\s+--hard|git\s+clean|force[- ]push|drop\s+table|rewrite\s+history)\b/i,
  ],
  shared: [
    /\b(?:push|pull request|merge into main|deploy|release|publish|production|staging|VPS|DNS|domain|CI config)\b/i,
    /\b(?:secret|credential|token|API key|password|SSH key|permission|sandbox|firewall)s?\b/i,
    /\b(?:another repository|other worktree|main checkout|shared document|global settings|calendar)\b|~\/|\.claude\b|\.codex\b/i,
    /\b(?:send|post)\b.{0,50}\b(?:email|message|Slack|Discord)\b/i,
    /\b(?:connect|access|configure|restart|update|change)\b.{0,50}\bserver\b/i,
  ],
};

export function classifyQuestionRisk(...texts: string[]): QuestionRiskClass | null {
  // Bound model-authored data and check each field separately: a phrase split
  // across an option and its rationale must not manufacture a risk match.
  for (const risk of ['scope', 'money', 'deletion', 'shared'] as const) {
    if (texts.some((text) => RISK_PATTERNS[risk].some((pattern) => pattern.test(text.slice(0, 8000))))) return risk;
  }
  return null;
}

export function loopQuestionNeed(item: Pick<LoopOutstandingItem, 'kind' | 'riskClass'>): 'answer' | 'applied' | 'fyi' {
  return item.kind === 'needs-human' || item.riskClass ? 'answer' : item.kind === 'decision-applied' ? 'applied' : 'fyi';
}

export function countsTowardNeedsYou(item: Pick<LoopOutstandingItem, 'kind' | 'riskClass' | 'status' | 'firstSeenRound' | 'userResponse'>): boolean {
  return item.status === 'open' && item.firstSeenRound != null && !item.userResponse?.trim() && loopQuestionNeed(item) !== 'fyi';
}

export function attentionLevelForLoopQuestion(item: LoopOutstandingItem): 'blocked' | 'review' | 'idle' {
  if (!countsTowardNeedsYou(item)) return 'idle';
  return loopQuestionNeed(item) === 'answer' ? 'blocked' : 'review';
}

export function loopQuestionLabel(need: ReturnType<typeof loopQuestionNeed>): string {
  return need === 'answer' ? 'Waiting for you' : need === 'applied' ? 'Decision applied, tell me if wrong' : 'For information';
}
