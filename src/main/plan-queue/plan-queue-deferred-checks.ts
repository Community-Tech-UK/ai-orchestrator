/**
 * Step 5.2: what a verdict says about work that is not code. Three rules live here, away from the flow that applies them:
 *
 * - every finding has a kind, and a FAIL whose findings are all `environment` or `needs-human` starts no new worker
 *   round: the item is set aside and the named missing thing is shown (a mislabelled finding is then visible, not
 *   hidden in another round);
 * - a PASS may list deferred checks (those need a rebuilt app, a person or an outside service). Each must be in the
 *   worker's report and written in the plan's `_livetest.md`, or it is not a PASS; and when more than half of the
 *   criteria are deferred the item is set aside instead of landing;
 * - stored verdicts written before kinds existed have no `kind` and read as `code`.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PlanQueueKind, PlanQueueParkReason, PlanQueueVerdict, PlanQueueWorkerReport } from '@contracts/schemas/plan-queue';

type FindingKind = 'code' | 'environment' | 'needs-human';
type Finding = PlanQueueVerdict['findings'][number];

/** A stored finding without a `kind` is a code finding. */
export function findingKind(finding: { kind?: FindingKind }): FindingKind { return finding.kind ?? 'code'; }

/**
 * A plan that passes is always closed. The refusal reaches the checker as the tool's error, so it says what to do
 * instead: FAIL with findings, or list the deferred checks and close.
 */
export function refuseUnclosedPlanPass(kind: PlanQueueKind, verdict: Pick<PlanQueueVerdict, 'verdict' | 'documentComplete'>): void {
  if (kind !== 'plans' || verdict.verdict !== 'PASS' || verdict.documentComplete) return;
  throw new Error('A passing plan is always closed, so PASS with document_complete: false is refused. '
    + 'If something still fails, report FAIL with findings, giving each finding a kind (code, environment or needs-human). '
    + 'If the only things left are checks that need a rebuilt or restarted app, a person or an outside service, report PASS with document_complete: true '
    + 'and list each one under deferred_checks (with criteria_total), after the worker has reported it and written it in the _livetest.md beside the plan.');
}

/** A verdict whose parts contradict each other is refused with a message the checker can act on. */
export function refuseInconsistentVerdict(verdict: Pick<PlanQueueVerdict, 'findings' | 'deferredChecks' | 'criteriaTotal'>): void {
  const unnamed = verdict.findings.find(finding => findingKind(finding) !== 'code' && !finding.missing);
  if (unnamed) {
    throw new Error(`A finding of kind "${findingKind(unnamed)}" must name the exact missing thing in "missing": the setting, command, device or approval.`);
  }
  const deferred = verdict.deferredChecks?.length ?? 0;
  if (deferred && (verdict.criteriaTotal === undefined || verdict.criteriaTotal < deferred)) {
    throw new Error('When you list deferred_checks, give criteria_total: how many acceptance criteria you judged in all, at least as many as the deferred checks.');
  }
}

export interface VerdictParking { reason: Extract<PlanQueueParkReason, 'needs-setup' | 'needs-james'>; detail: string }

function describe(finding: Finding): string {
  const missing = finding.missing ? `${finding.missing}: ` : '';
  return `${missing}${finding.summary}`;
}

/**
 * Set the item aside when the checker failed it and nothing it found is something a worker can fix.
 * Any `code` finding keeps the normal fix round, and a FAIL without findings is judged as before.
 */
export function parkingForFailure(verdict: PlanQueueVerdict): VerdictParking | null {
  if (verdict.verdict !== 'FAIL' || !verdict.findings.length) return null;
  if (verdict.findings.some(finding => findingKind(finding) === 'code')) return null;
  const human = verdict.findings.filter(finding => findingKind(finding) === 'needs-human');
  const setup = verdict.findings.filter(finding => findingKind(finding) === 'environment');
  const lines = [
    ...(human.length ? ['Only you can provide:', ...human.map(finding => `- ${describe(finding)}`)] : []),
    ...(setup.length ? ['Missing setup on this computer:', ...setup.map(finding => `- ${describe(finding)}`)] : []),
  ];
  return {
    reason: human.length ? 'needs-james' : 'needs-setup',
    detail: `The checker could not pass this work, and nothing it found is a code change a worker can make. ${lines.join('\n')}\nResume once this is provided.`,
  };
}

/** The number of deferred checks is more than half the criteria: the item is set aside instead of landing. */
export function parkingForDeferrals(verdict: PlanQueueVerdict): VerdictParking | null {
  const deferred = verdict.deferredChecks ?? [];
  if (verdict.verdict !== 'PASS' || !deferred.length || verdict.criteriaTotal === undefined) return null;
  if (deferred.length * 2 <= verdict.criteriaTotal) return null;
  return {
    reason: 'needs-james',
    detail: `The checker passed the work, but left ${deferred.length} of ${verdict.criteriaTotal} acceptance criteria to be checked live. That is more than half, so it was not merged.\n`
      + `${deferred.map(check => `- ${check.title}: ${check.whyDeferred}`).join('\n')}\nCheck what it covers, then Merge without checks or Resume for more work.`,
  };
}

const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();
/** The title as a whole phrase, so "live check" is not found inside "live checks". */
const mentions = (body: string, title: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${normalise(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(body);

/** Where the worker may have written the deferred checks: `<plan>_livetest.md`, with or without `_plan` and `_completed`. */
export function livetestPathsFor(documentPath: string): string[] {
  const dir = path.dirname(documentPath);
  const stem = path.basename(documentPath, '.md');
  const bare = stem.replace(/_completed$/, '');
  const names = new Set([bare, bare.replace(/_plan$/, '')]);
  return [...names].map(name => path.join(dir, `${name}_livetest.md`));
}

async function readLivetest(documentPath: string): Promise<string | null> {
  for (const candidate of livetestPathsFor(documentPath)) {
    try { return await fs.readFile(candidate, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

const codeFinding = (summary: string, evidence?: string): Finding => ({ severity: 'high', kind: 'code', confidence: 100, summary, ...(evidence ? { evidence } : {}) });

/**
 * Findings that stop a plan's PASS from standing: each deferred check must be in the worker's report, and the
 * report's checks must be written in the livetest file. Empty when the verdict lists no deferred checks.
 */
export async function deferredPassProblems(
  verdict: PlanQueueVerdict, report: PlanQueueWorkerReport | null | undefined, documentPath: string,
): Promise<Finding[]> {
  const deferred = verdict.deferredChecks ?? [];
  if (verdict.verdict !== 'PASS' || !deferred.length) return [];
  const reported = new Set((report?.deferredChecks ?? []).map(check => normalise(check.title)));
  const unreported = deferred.filter(check => !reported.has(normalise(check.title)));
  if (unreported.length) {
    return [codeFinding(
      `The checker found ${unreported.length === 1 ? 'a deferred check' : 'deferred checks'} that the worker's report does not list: ${unreported.map(check => `"${check.title}"`).join(', ')}.`,
      'Report each one with plan_queue_report_ready under deferred_checks (title, steps, expected result, why it is deferred) and write it in the _livetest.md beside the plan.',
    )];
  }
  const text = await readLivetest(documentPath);
  if (text === null) {
    return [codeFinding(`No livetest document was found beside the plan for its deferred checks (looked for ${livetestPathsFor(documentPath).map(file => path.basename(file)).join(' or ')}).`,
      'Write each deferred check in that file, following the Live-Test Deferral rules in AGENTS.md.')];
  }
  const body = normalise(text);
  const absent = deferred.filter(check => !mentions(body, check.title));
  return absent.length
    ? [codeFinding(`The livetest document does not contain ${absent.length === 1 ? 'this deferred check' : 'these deferred checks'}: ${absent.map(check => `"${check.title}"`).join(', ')}.`,
      'Add each one with its exact steps, expected result and why it cannot run now, under the same title as in the report.')]
    : [];
}
