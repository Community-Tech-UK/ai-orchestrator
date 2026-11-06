/**
 * Presenter-only text helpers for Plan Queue cards, shared with the words agents read: strip absolute paths
 * from displayed details, fold long ones, and small plain-English word rules.
 * Never touches stored data.
 */
import type { PlanQueueItemDto, PlanQueueKind, PlanQueueRunDto } from '@contracts/schemas/plan-queue';

const UNIX_ABSOLUTE_PATH = /(?<![\w.~:/])((?:\/[\w.+-]+){2,})/g;
const WINDOWS_ABSOLUTE_PATH = /(?<![\w])[A-Za-z]:[\\/](?:[\w.+-]+[\\/])*([\w.+-]+)/g;

function toPlaceholder(pathText: string): string {
  const parts = pathText.split(/[\\/]/).filter(Boolean);
  const basename = parts[parts.length - 1] ?? '';
  return `…/${basename}`;
}

/** Replace `/Users/...` and drive-letter paths with a plain `…/` placeholder, keeping the file name. */
export function stripAbsolutePaths(text: string): string {
  return text
    .replace(UNIX_ABSOLUTE_PATH, (match) => toPlaceholder(match))
    .replace(WINDOWS_ABSOLUTE_PATH, (_match, basename: string) => `…/${basename}`);
}

export interface FoldedDetail {
  /** The whole detail, paths stripped. */
  text: string;
  /** A short line for the card when the detail is long. */
  preview: string;
  /** True when the card should fold this behind its Details disclosure. */
  long: boolean;
}

const PREVIEW_CHARS = 160;
const LONG_DETAIL_CHARS = 400;

/** Fold a raw stored detail for display: strip its absolute paths and preview it when long. */
export function foldDetail(detail: string | null | undefined): FoldedDetail | null {
  if (!detail) return null;
  const text = stripAbsolutePaths(detail);
  const long = text.length > LONG_DETAIL_CHARS;
  const firstLine = text.split('\n', 1)[0];
  return {
    text,
    preview: long ? `${firstLine.slice(0, PREVIEW_CHARS)}…` : text,
    long,
  };
}

/** `…/desk-shared-crm_plan.md` → `desk-shared-crm`. */
export function planQueueDocumentLabel(documentPath: string): string {
  const name = documentPath.split(/[\\/]/).pop() ?? documentPath;
  return name.replace(/\.md$/i, '').replace(/_(plan|livetest|spec(_planned)?)$/i, '');
}

/** Real singular/plural, never "item(s)". */
export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const KIND_LABELS: Record<PlanQueueKind, string> = {
  plans: 'Plans',
  livetests: 'Live checks',
};

/** The run kind in plain words; the raw code never reaches the screen. */
export function planQueueKindLabel(kind: PlanQueueKind): string {
  return KIND_LABELS[kind] ?? kind;
}

/** The checked group is useful context; its internal identifiers stay off the card. */
export function planQueueCheckGroupLabel(item: PlanQueueItemDto): string | null {
  const group = item.verdict?.gatesRun.find(gate => gate.checkGroup)?.checkGroup;
  if (!group?.memberItemIds.includes(item.id)) return null;
  const others = new Set(group.memberItemIds.filter(id => id !== item.id)).size;
  return others ? `Checked together with ${pluralise(others, 'other job')}` : null;
}

export function planQueueChecksLabel(checks: PlanQueueRunDto['checks']): string | null {
  return checks?.runs ? `${pluralise(checks.runs, 'test run')} covered ${pluralise(checks.jobs, 'job')}` : null;
}
