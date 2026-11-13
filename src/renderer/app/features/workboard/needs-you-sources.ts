import { NEEDS_YOU_RECENCY_MS, type NeedsYouEntry } from '../../../../shared/attention/needs-you';
import { countsTowardNeedsYou, loopQuestionLabel, loopQuestionNeed } from '../../../../shared/attention/question-need';
import { sideChatParentKey, type SideChatAttention } from '../../../../shared/types/side-chat.types';
import type { WorkboardItem } from './workboard.types';
import { planQueueDocumentLabel } from '../../../../shared/utils/plan-queue-item-display';
import type { LoopOutstandingItem } from '../../../../shared/types/loop-outstanding.types';
import type { PendingRequest } from '../../core/state/pending-request.store';
import { friendlyToolName } from '../../../../shared/permissions/friendly-tool-name';
import { TOOL_LOOP_TITLE, describeToolLoop, type ToolLoopSummaryInput } from '../../../../shared/tool-loop-summary';

export type OutstandingNeed = Pick<LoopOutstandingItem, 'id' | 'kind' | 'status' | 'riskClass' | 'firstSeenRound'
  | 'userResponse' | 'text' | 'chatId' | 'createdAt' | 'updatedAt'>;
export interface NeedsYouSources {
  permissions: readonly { id: string; instanceId: string; description: string; createdAt: number; expiresAt: number }[];
  browsers: readonly { requestId: string; instanceId?: string; createdAt: number; expiresAt: number }[];
  fallbacks: readonly { id: string; slot: string; createdAt: number; expiresAt: number }[];
  plans: readonly { id: string; sourceRef: string; updatedAt: number }[];
  documents: readonly { id: string; title: string; status: string; createdAt: number }[];
  memories: readonly { id: string; title: string; status: string; createdAt: number }[];
  sidechats: readonly Pick<SideChatAttention, 'parent' | 'parentTitle' | 'needsAttention' | 'attentionSince'>[];
  outstanding: readonly OutstandingNeed[];
  toolLoops: readonly (ToolLoopSummaryInput & { instanceId: string; detectedAt: number; sessionName?: string })[];
}

export function workboardEntry(item: WorkboardItem): NeedsYouEntry {
  const source = item.primary.kind === 'instance' ? 'session' : item.primary.kind;
  return {
    key: workboardEntryKey(item), source, kind: item.attentionLevel === 'blocked' ? 'answer' : 'check',
    title: item.title, detail: item.detail ?? item.statusLabel, instanceId: item.instanceId,
    route: '/work', since: item.updatedAt,
    version: `${item.attentionLevel}:${item.relations?.map((r) => `${r.kind}:${r.id}:${r.rawStatus}:${r.updatedAt}`).join('|') ?? item.updatedAt}`,
  };
}

const SOURCE_NAMES: Partial<Record<NeedsYouEntry['source'], string>> = {
  'session': 'Session', 'loop-run': 'Loop', 'automation-run': 'Automation', 'repo-job': 'Repository job',
};

/**
 * One short line saying what a session is waiting on, shown under its name in the session list.
 * `statusSentence` is the most specific plain status wording for what needs you (the session's own
 * status, or a loop's pause or end wording); `request` is the live permission prompt or question, if any.
 */
export function needsYouReason(entry: NeedsYouEntry, statusSentence?: string,
  request?: Pick<PendingRequest, 'kind' | 'toolName' | 'text'>): string {
  if (request?.kind === 'permission') return request.toolName ? `Wants permission to use ${friendlyToolName(request.toolName)}` : 'Wants your permission';
  if (request?.kind === 'question' && request.text.trim()) return `Asked you: ${request.text}`;
  if (statusSentence) return statusSentence;
  switch (entry.source) {
    case 'permission-request': return `Wants permission: ${entry.title}`;
    case 'browser-approval': return 'Wants your OK for a browser step';
    case 'loop-question': return entry.detail ? `Asked you: ${entry.detail}` : entry.title;
    // The session list already shows the name beside this line.
    case 'tool-loop': return TOOL_LOOP_TITLE;
  }
  const name = SOURCE_NAMES[entry.source];
  if (!name) return entry.title;
  return entry.kind === 'answer' ? `${name} is waiting for you` : `${name} stopped with a problem`;
}

export function workboardEntryKey(item: WorkboardItem): string {
  return item.primary.kind === 'instance' ? item.id.replace(/^instance:/, 'session:') : item.id;
}

/** All non-Workboard sources, conservatively filtered at the boundary. */
export function requestEntries(sources: NeedsYouSources, now: number): NeedsYouEntry[] {
  const entries: NeedsYouEntry[] = [];
  const add = (source: NeedsYouEntry['source'], id: string, title: string, since: number,
    extra: Partial<NeedsYouEntry> = {}) => entries.push({ key: `${source}:${id}`, source, kind: 'answer', title, since, version: String(since), ...extra });
  for (const item of sources.permissions) {
    if (item.expiresAt > now) add('permission-request', item.id, item.description, item.createdAt, { instanceId: item.instanceId, deadlineAt: item.expiresAt, route: '/work' });
  }
  for (const item of sources.browsers) {
    if (item.expiresAt > now) add('browser-approval', item.requestId, 'Browser approval needed', item.createdAt, { instanceId: item.instanceId, deadlineAt: item.expiresAt, route: '/work' });
  }
  for (const item of sources.fallbacks) {
    if (item.expiresAt > now) add('paid-fallback', item.id, 'Allow a paid model?', item.createdAt, { detail: item.slot, deadlineAt: item.expiresAt, route: '/local-ai' });
  }
  const plans = new Map<string, NeedsYouSources['plans'][number][]>();
  for (const item of sources.plans) plans.set(item.sourceRef, [...(plans.get(item.sourceRef) ?? []), item]);
  for (const [path, items] of plans) {
    add('plan-queue-question', path, `Plan Queue has ${items.length} ${items.length === 1 ? 'question' : 'questions'} for you`,
      Math.min(...items.map((i) => i.updatedAt)), { detail: planQueueDocumentLabel(path), route: `/plan-queue?document=${encodeURIComponent(path)}`, version: items.map((i) => `${i.id}:${i.updatedAt}`).sort().join('|') });
  }
  for (const item of sources.documents) {
    if (item.status === 'pending' && item.createdAt >= now - NEEDS_YOU_RECENCY_MS && item.createdAt <= now) {
      add('doc-review', item.id, item.title, item.createdAt, { route: '/doc-review' });
    }
  }
  for (const item of sources.memories) {
    if (item.status === 'pending') add('memory-review', item.id, item.title, item.createdAt, { kind: 'check', route: '/memory-review' });
  }
  for (const item of sources.sidechats) {
    if (item.needsAttention > 0) add('sidechat', sideChatParentKey(item.parent), item.parentTitle ?? 'Sidechat needs you', item.attentionSince ?? Number.MAX_SAFE_INTEGER,
      { route: '/work', version: `${item.needsAttention}:${item.attentionSince ?? ''}` });
  }
  for (const item of sources.outstanding) {
    if (!countsTowardNeedsYou(item)) continue;
    const need = loopQuestionNeed(item);
    add(need === 'applied' ? 'loop-decision' : 'loop-question', item.id, loopQuestionLabel(need), item.createdAt,
      { kind: need === 'applied' ? 'applied' : 'answer', detail: item.text, instanceId: item.chatId, route: '/work', version: String(item.updatedAt) });
  }
  // The card names the session, so two stuck sessions never show two identical "Stop this turn" cards.
  for (const item of sources.toolLoops) add('tool-loop', item.instanceId,
    item.sessionName ? `${item.sessionName} may be stuck: stop it or let it continue` : TOOL_LOOP_TITLE, item.detectedAt,
    { instanceId: item.instanceId, detail: describeToolLoop(item) });
  return entries;
}
