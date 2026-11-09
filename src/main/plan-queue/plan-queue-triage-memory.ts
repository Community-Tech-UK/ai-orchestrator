/**
 * Triage decision memory (Step 6): remember what triage decided and what
 * James answered, keyed by SHA-256 of the document content plus its linked
 * spec. An unchanged document reuses the remembered decision or answer with
 * "Already decided on <date>" instead of asking again; answers are keyed per
 * question, so a different question is still asked.
 *
 * Items of a cancelled run are "not reached", never a skip decision: nothing
 * on the cancel path writes here. The shared item-outcome presenter keeps
 * them distinguishable from James's own Skip presses.
 */

import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { PlanQueueQuestion } from '@contracts/schemas/plan-queue';
import type {
  PlanQueueHistoryStore,
  PlanQueueTriageAnswer,
  PlanQueueTriageDecision,
} from './plan-queue-history-store';
import type { PlanQueueItem } from './plan-queue.types';

const SPEC_LINE_RE = /^\*\*Spec:\*\*(.*)$/m;
const MARKDOWN_LINK_TARGET_RE = /\]\(([^)\s]+\.md)\)/;
const HEADER_BYTES = 16 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024;

/** Optional caching never reads arbitrary linked files or unbounded data on the main thread. */
function readMemoryBytes(file: string, repoRoot: string): Buffer {
  const resolved = realpathSync(file);
  const relative = path.relative(repoRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Memory input is outside the repository');
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_MEMORY_BYTES) throw new Error('Memory input exceeds the cache budget');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('Memory input changed while it was read');
    }
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

function readLinkedSpec(documentPath: string, content: string): string | null {
  const header = content.slice(0, HEADER_BYTES);
  const specLine = SPEC_LINE_RE.exec(header)?.[1];
  const target = specLine ? MARKDOWN_LINK_TARGET_RE.exec(specLine)?.[1] : undefined;
  const candidates = target && !/^[a-z]+:\/\//i.test(target)
    ? [path.resolve(path.dirname(documentPath), decodeURIComponent(target))]
    : [];
  // A named local dependency must be readable in full; never cache a decision
  // against the document alone when that dependency is missing or unreadable.
  if (candidates.length) return candidates[0];
  const stem = path.basename(documentPath).replace(/\.md$/i, '').replace(/_(plan|livetest)$/i, '');
  candidates.push(
    path.join(path.dirname(documentPath), `${stem}_spec_planned.md`),
    path.join(path.dirname(documentPath), `${stem}_spec_completed.md`),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The memory key: SHA-256 of the document's bytes plus its linked spec's
 * bytes (the `**Spec:**` link, else the sibling `_spec_planned` /
 * `_spec_completed` name). Null when the document cannot be read.
 */
export function triageMemoryKey(documentPath: string, repoRoot: string): string | null {
  try {
    repoRoot = realpathSync(repoRoot);
    const content = readMemoryBytes(documentPath, repoRoot);
    const hash = createHash('sha256').update(JSON.stringify([path.resolve(documentPath), content.length])).update(content);
    const spec = readLinkedSpec(documentPath, content.toString('utf-8'));
    if (spec) {
      const specBytes = readMemoryBytes(spec, repoRoot);
      hash.update(JSON.stringify([path.resolve(spec), specBytes.length])).update(specBytes);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/** "Already decided on 14 Oct" (the plan's own wording). */
export function formatDecidedOn(decidedAt: number): string {
  const date = new Date(decidedAt);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

export type RememberedOutcome =
  | { kind: 'none'; detail: '' }
  | { kind: 'ready'; detail: string }
  | { kind: 'skip'; detail: string }
  | { kind: 'answered'; optionId: string; question: string; optionLabel: string; detail: string }
  | { kind: 'ask'; question: PlanQueueQuestion; detail: string };

/**
 * What an unchanged document's remembered decision means for its next run:
 * a decided answer is applied with "Already decided on <date>"; only a
 * question that was never answered is asked again.
 */
export function rememberedOutcome(decision: PlanQueueTriageDecision | null): RememberedOutcome {
  if (!decision) return { kind: 'none', detail: '' };
  const when = formatDecidedOn(decision.decidedAt);
  if (decision.disposition === 'ready') {
    return { kind: 'ready', detail: `Already decided on ${when}: ready to work on.` };
  }
  if (decision.disposition === 'skip') {
    return { kind: 'skip', detail: `Already decided on ${when}: ${decision.reason ?? 'left out'}` };
  }
  const question = decision.question;
  const answered = question
    ? decision.answers.find((answer) => answer.question === question.question)
    : undefined;
  if (question && answered) {
    return {
      kind: 'answered',
      optionId: answered.optionId,
      question: answered.question,
      optionLabel: answered.optionLabel,
      detail: `Already decided on ${when}: ${answered.optionLabel}`,
    };
  }
  if (question) {
    return {
      kind: 'ask',
      question,
      detail: `The same question was asked on ${when} and left open.`,
    };
  }
  return { kind: 'none', detail: '' };
}

/** The remembered decision for a document as it is on disk now. */
export function rememberedOutcomeForPath(
  memory: PlanQueueHistoryStore | undefined,
  documentPath: string,
  repoRoot: string,
): RememberedOutcome {
  if (!memory) return { kind: 'none', detail: '' };
  const key = triageMemoryKey(documentPath, repoRoot);
  return rememberedOutcome(key ? memory.getTriageDecision(key) : null);
}

/** Remember a triage disposition (never a cancelled run's leftovers). */
export function rememberTriageRecord(
  memory: PlanQueueHistoryStore | undefined,
  documentPath: string,
  repoRoot: string,
  record: { disposition: 'ready' | 'needs-answer' | 'skip'; reason?: string | null; question?: PlanQueueQuestion | null },
  decidedAt: number,
): void {
  if (!memory) return;
  const key = triageMemoryKey(documentPath, repoRoot);
  if (!key) return;
  const existing = memory.getTriageDecision(key);
  memory.rememberTriageDecision({
    documentSha256: key,
    disposition: record.disposition,
    reason: record.reason ?? existing?.reason ?? null,
    question: record.question ?? existing?.question ?? null,
    answers: existing?.answers ?? [],
    source: 'triage',
    decidedAt,
  });
}

/** Remember James's answer, keyed by document content plus the question. */
export function rememberJamesAnswer(
  memory: PlanQueueHistoryStore | undefined,
  item: Pick<PlanQueueItem, 'sourceRef'>,
  repoRoot: string,
  question: string,
  option: { id: string; label: string },
  decidedAt: number,
): void {
  if (!memory) return;
  const key = triageMemoryKey(item.sourceRef, repoRoot);
  if (!key) return;
  const answer: PlanQueueTriageAnswer = { question, optionId: option.id, optionLabel: option.label };
  memory.rememberTriageAnswer(key, answer, decidedAt);
}
