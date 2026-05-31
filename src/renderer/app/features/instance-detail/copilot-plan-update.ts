import type { OutputMessage } from '../../core/state/instance/instance.types';

export type CopilotPlanStatusKind = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'unknown';
export type CopilotPlanPriorityKind = 'high' | 'medium' | 'low' | 'unknown';

export interface CopilotPlanEntry {
  content: string;
  statusKind: CopilotPlanStatusKind;
  statusLabel: string;
  priorityKind: CopilotPlanPriorityKind;
  priorityLabel?: string;
}

export interface CopilotPlanUpdate {
  entries: CopilotPlanEntry[];
  totalCount: number;
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  cancelledCount: number;
  unknownCount: number;
  preview?: string;
}

interface NormalizedStatus {
  kind: CopilotPlanStatusKind;
  label: string;
}

interface NormalizedPriority {
  kind: CopilotPlanPriorityKind;
  label?: string;
}

const COMPLETED_STATUS_VALUES = new Set([
  'complete',
  'completed',
  'done',
  'finished',
  'success',
  'succeeded',
]);

const IN_PROGRESS_STATUS_VALUES = new Set([
  'active',
  'doing',
  'in_progress',
  'inprogress',
  'running',
  'started',
  'working',
]);

const PENDING_STATUS_VALUES = new Set([
  'next',
  'not_started',
  'pending',
  'planned',
  'queued',
  'todo',
]);

const CANCELLED_STATUS_VALUES = new Set([
  'abandoned',
  'canceled',
  'cancelled',
  'skipped',
  'stopped',
]);

const HIGH_PRIORITY_VALUES = new Set([
  'blocker',
  'critical',
  'high',
  'highest',
  'urgent',
]);

const MEDIUM_PRIORITY_VALUES = new Set([
  'default',
  'medium',
  'med',
  'normal',
  'standard',
]);

const LOW_PRIORITY_VALUES = new Set([
  'low',
  'minor',
  'nice_to_have',
  'optional',
]);

const PLAN_LINE_RE = /^\s*[-*]\s+(.*)$/;
const PLAN_ENTRY_TRAILING_META_RE = /\s*\(([^()]*)\)\s*$/;
const EMPTY_PLAN_CONTENT_RE = /^plan:\s*no entries advertised\.?$/i;

export function isCopilotPlanUpdateMessage(
  message: Pick<OutputMessage, 'type' | 'metadata' | 'content'>,
): boolean {
  return message.type === 'system' && (
    message.metadata?.['sessionUpdate'] === 'plan'
    || extractPlanEntriesFromContent(message.content).length > 0
    || isEmptyPlanContent(message.content)
  );
}

export function parseCopilotPlanUpdate(
  message: Pick<OutputMessage, 'type' | 'metadata' | 'content'>,
): CopilotPlanUpdate | null {
  if (!isCopilotPlanUpdateMessage(message)) {
    return null;
  }

  const metadata = message.metadata;
  const rawEntries = metadata?.['entries'];
  const hasStructuredPlanMetadata = metadata?.['sessionUpdate'] === 'plan';
  const entriesFromMetadata = Array.isArray(rawEntries)
    ? rawEntries.flatMap((entry) => {
        if (!isRecord(entry)) {
          return [];
        }

        const rawContent = entry['content'];
        if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
          return [];
        }

        const status = normalizeStatus(entry['status']);
        const priority = normalizePriority(entry['priority']);

        return [{
          content: rawContent.trim(),
          statusKind: status.kind,
          statusLabel: status.label,
          priorityKind: priority.kind,
          priorityLabel: priority.label,
        }];
      })
    : [];
  const entries = entriesFromMetadata.length > 0
    ? entriesFromMetadata
    : extractPlanEntriesFromContent(message.content);

  if (entries.length === 0 && !hasStructuredPlanMetadata && !isEmptyPlanContent(message.content)) {
    return null;
  }

  const update: CopilotPlanUpdate = {
    entries,
    totalCount: entries.length,
    pendingCount: 0,
    inProgressCount: 0,
    completedCount: 0,
    cancelledCount: 0,
    unknownCount: 0,
    preview: resolvePreview(entries),
  };

  for (const entry of entries) {
    switch (entry.statusKind) {
      case 'pending':
        update.pendingCount++;
        break;
      case 'in_progress':
        update.inProgressCount++;
        break;
      case 'completed':
        update.completedCount++;
        break;
      case 'cancelled':
        update.cancelledCount++;
        break;
      case 'unknown':
        update.unknownCount++;
        break;
    }
  }

  return update;
}

export function summarizeCopilotPlanUpdate(plan: CopilotPlanUpdate): string {
  if (plan.totalCount === 0) {
    return 'No advertised steps';
  }

  const parts = [`${plan.totalCount} step${plan.totalCount === 1 ? '' : 's'}`];
  if (plan.inProgressCount > 0) {
    parts.push(`${plan.inProgressCount} active`);
  }
  if (plan.completedCount > 0) {
    parts.push(`${plan.completedCount} done`);
  }
  if (plan.pendingCount > 0) {
    parts.push(`${plan.pendingCount} pending`);
  }
  if (plan.cancelledCount > 0) {
    parts.push(`${plan.cancelledCount} cancelled`);
  }
  if (plan.unknownCount > 0) {
    parts.push(`${plan.unknownCount} other`);
  }

  return parts.join(' · ');
}

function resolvePreview(entries: readonly CopilotPlanEntry[]): string | undefined {
  return entries.find((entry) => entry.statusKind === 'in_progress')?.content
    ?? entries.find((entry) => entry.statusKind === 'pending')?.content
    ?? entries.at(-1)?.content;
}

function normalizeStatus(value: unknown): NormalizedStatus {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { kind: 'unknown', label: 'Unknown' };
  }

  const token = normalizeToken(value);
  if (COMPLETED_STATUS_VALUES.has(token)) {
    return { kind: 'completed', label: 'Done' };
  }
  if (IN_PROGRESS_STATUS_VALUES.has(token)) {
    return { kind: 'in_progress', label: 'In progress' };
  }
  if (PENDING_STATUS_VALUES.has(token)) {
    return { kind: 'pending', label: 'Pending' };
  }
  if (CANCELLED_STATUS_VALUES.has(token)) {
    return { kind: 'cancelled', label: 'Cancelled' };
  }

  return { kind: 'unknown', label: humanizeToken(value) };
}

function normalizePriority(value: unknown): NormalizedPriority {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { kind: 'unknown' };
  }

  const token = normalizeToken(value);
  if (HIGH_PRIORITY_VALUES.has(token)) {
    return { kind: 'high', label: 'High' };
  }
  if (MEDIUM_PRIORITY_VALUES.has(token)) {
    return { kind: 'medium', label: 'Medium' };
  }
  if (LOW_PRIORITY_VALUES.has(token)) {
    return { kind: 'low', label: 'Low' };
  }

  return {
    kind: 'unknown',
    label: humanizeToken(value),
  };
}

function extractPlanEntriesFromContent(content: string | undefined): CopilotPlanEntry[] {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return [];
  }

  const lines = content.split(/\r?\n/);
  const planStartIdx = lines.findIndex((line) => line.trim().toLowerCase() === 'plan:');
  if (planStartIdx === -1) {
    return [];
  }

  return lines
    .slice(planStartIdx + 1)
    .flatMap((line) => {
      const match = line.match(PLAN_LINE_RE);
      if (!match) {
        return [];
      }

      const parsed = parsePlanLine(match[1] ?? '');
      return parsed ? [parsed] : [];
    });
}

function isEmptyPlanContent(content: string | undefined): boolean {
  if (typeof content !== 'string') {
    return false;
  }

  return EMPTY_PLAN_CONTENT_RE.test(content.trim());
}

function parsePlanLine(rawLine: string): CopilotPlanEntry | null {
  const line = rawLine.trim();
  if (!line) {
    return null;
  }

  const trailingMeta = line.match(PLAN_ENTRY_TRAILING_META_RE);
  const content = trailingMeta ? line.slice(0, trailingMeta.index).trim() : line;
  if (!content) {
    return null;
  }

  const [rawStatus, rawPriority] = trailingMeta?.[1]
    ?.split('/')
    .map((part) => part.trim())
    .filter(Boolean) ?? [];
  const status = normalizeStatus(rawStatus);
  const priority = normalizePriority(rawPriority);

  return {
    content,
    statusKind: status.kind,
    statusLabel: status.label,
    priorityKind: priority.kind,
    priorityLabel: priority.label,
  };
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^\w\s-]+/g, '')
    .replace(/[\s-]+/g, '_');
}

function humanizeToken(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
