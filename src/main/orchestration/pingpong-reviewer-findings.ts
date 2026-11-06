import type { PingPongSeverity } from '../../shared/types/loop-pingpong.types';
import { ReviewSeveritySchema } from '../../shared/types/review-severity';
import type { PingPongReviewFinding } from './agentic-pingpong-reviewer';

/**
 * Field contract for one reviewer finding, stated in the reviewer prompt.
 * Before it was stated, Codex reviewers invented `issue` / `location` /
 * `suggestedFix` for every finding and the parser dropped all of them (LT-644).
 */
export const REVIEWER_FINDING_FIELDS_INSTRUCTION =
  '- findings[]: an object per issue with "title" (one line), "severity", "file" ' +
  '("path:line" where it applies), "evidence" (what you inspected that shows it), ' +
  '"body" (what is wrong and how to fix it), "novelty", and "ledgerId" when it maps to ' +
  'a prior ledger issue.';

// Names reviewers used for the same fields before the contract above was
// stated (captured from real Codex rollouts, 2026-09-24).
const TITLE_KEYS = ['title', 'issue'] as const;
const FILE_KEYS = ['file', 'location'] as const;
const BODY_KEYS = ['body', 'suggestedFix', 'description', 'detail'] as const;

export interface NormalizedReviewerFindings {
  findings: PingPongReviewFinding[];
  /** Entries present in the reviewer's list that could not be used. */
  dropped: number;
}

function firstText(f: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = f[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseSeverity(value: unknown): PingPongSeverity | null {
  const parsed = ReviewSeveritySchema.safeParse(String(value ?? '').toLowerCase());
  return parsed.success ? parsed.data : null;
}

function coerceNovelty(value: unknown): PingPongReviewFinding['novelty'] {
  const s = String(value ?? '').toLowerCase();
  if (s === 'persisted' || s === 'regression') return s;
  return 'new';
}

/** Evidence-required: a finding without a title, evidence and a valid severity is dropped. */
export function normalizeReviewerFindings(raw: unknown): NormalizedReviewerFindings {
  if (!Array.isArray(raw)) return { findings: [], dropped: 0 };
  const findings: PingPongReviewFinding[] = [];
  let dropped = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      dropped += 1;
      continue;
    }
    const f = item as Record<string, unknown>;
    const title = firstText(f, TITLE_KEYS);
    const evidence = firstText(f, ['evidence']);
    const severity = parseSeverity(f['severity']);
    if (!title || !evidence || !severity) {
      dropped += 1;
      continue;
    }
    const file = firstText(f, FILE_KEYS);
    const ledgerId = firstText(f, ['ledgerId']);
    findings.push({
      title,
      severity,
      ...(file ? { file } : {}),
      evidence,
      body: firstText(f, BODY_KEYS),
      novelty: coerceNovelty(f['novelty']),
      ...(ledgerId ? { ledgerId } : {}),
    });
  }
  return { findings, dropped };
}

/** Cap on NEW low/medium findings per round to throttle nitpick churn. */
const MAX_NEW_LOW_FINDINGS = 5;

/** Throttle nitpick churn: keep all blocking findings, cap NEW low/medium ones. */
export function capLowSeverityChurn(
  findings: PingPongReviewFinding[],
  blocking: readonly PingPongSeverity[],
): PingPongReviewFinding[] {
  const blockingSet = new Set(blocking);
  const kept: PingPongReviewFinding[] = [];
  let lowCount = 0;
  for (const f of findings) {
    if (blockingSet.has(f.severity)) {
      kept.push(f);
      continue;
    }
    if (f.novelty === 'new') {
      if (lowCount >= MAX_NEW_LOW_FINDINGS) continue;
      lowCount++;
    }
    kept.push(f);
  }
  return kept;
}
