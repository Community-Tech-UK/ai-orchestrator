/**
 * The verdict half of the checker's prompt (step 5.2): what the three finding kinds mean, how a plan's PASS defers
 * checks, and the example call, which differs by kind of run. Livetests keep their meaning: a livetest can PASS with
 * checks left for James (`need_james`) and `document_complete: false`; a plan that passes is always closed.
 */
import type { PlanQueueKind } from '@contracts/schemas/plan-queue';

const FINDING_KIND_RULES = [
  'Give every finding a `kind`:',
  '- `code`: something a worker can fix in the repository. This is the normal kind.',
  '- `environment`: something that stops an agent running its own gates or doing the work here, such as missing setup, a wrong Node version, a missing credential or a gate that cannot run on this computer. Name the exact missing thing in `missing`.',
  '- `needs-human`: an approval or a fact only James can give. Name the exact missing thing in `missing`.',
  'A FAIL whose findings are all `environment` or `needs-human` starts no new worker round: the item is set aside and James is shown what is missing. Any `code` finding keeps the normal fix round. Do not label a code problem `environment` to avoid a fix round; a worker can fix it, and the label is shown to James.',
];

const PLAN_DEFERRAL_RULES = [
  'A passing plan is always closed. `document_complete` is not a choice for a plan: PASS with `document_complete: false` is refused. If something still fails, report FAIL with findings.',
  'A criterion that can only be proved in a rebuilt or restarted app, by a person or by an outside service is a deferred check, and the PASS can still stand:',
  '- Checks you can run yourself (unit tests, the dev app, the command line) are never deferred.',
  '- List each deferred check under `deferred_checks` with the same title as in the worker\'s report, and why it cannot run now. Give `criteria_total`: how many acceptance criteria you judged in all.',
  '- Each deferred check must already be in the worker\'s report (below) and written in the `_livetest.md` beside the plan. If you find one the worker did not report, or the livetest document does not hold it, FAIL with a finding asking the worker to write it down; the coordinator also turns a PASS into a FAIL when either is missing.',
  '- When more than half of the criteria would be deferred, the item is set aside for James instead of merged.',
];

/** A step job never closes its plan, so the closing rule above does not apply to it. */
const STEP_CLOSING_RULE = 'A step of a plan that runs one job per step never closes the plan, so `document_complete` closes nothing for you: report PASS with `document_complete: false` when this step passes (it is not refused), and `true` only if no other step has anything left. If something in this step still fails, report FAIL with findings.';

/** The rules that follow the criteria. `step` is true for a job that covers one step of a plan. */
export function verdictRules(kind: PlanQueueKind, step = false): string[] {
  const plan = step ? [STEP_CLOSING_RULE, ...PLAN_DEFERRAL_RULES.slice(1)] : PLAN_DEFERRAL_RULES;
  return [...FINDING_KIND_RULES, ...(kind === 'plans' ? ['', ...plan] : [])];
}

/** The example call arguments: the last JSON object in the prompt, which must always be a valid call. */
export function verdictExamples(kind: PlanQueueKind, itemId: string, firstGate: string, step = false): string[] {
  const livetest = kind === 'livetests';
  const gates = [{ command: firstGate, exitCode: 0 }];
  const fail = {
    item_id: itemId,
    verdict: 'FAIL',
    findings: [
      { severity: 'high', kind: 'code', confidence: 90, summary: 'The retry path never resets the attempt counter.', file: 'src/main/example/retry.ts:42', evidence: 'attempts is incremented on line 42 and never cleared on success.' },
      { severity: 'high', kind: 'environment', confidence: 95, summary: 'The signing gate cannot run on this computer.', missing: 'The CODESIGN_IDENTITY environment variable and the certificate it names', evidence: 'npm run sign exits 1 with "no identity found".' },
    ],
    gates_run: gates,
    not_checked: [],
    ...(livetest ? { document_complete: false, need_james: [{ check: 'Check 3: Face ID unlock', classification: 'real', reason: 'Needs a physical iPhone with enrolled biometrics.' }] } : {}),
  };
  if (livetest) return [JSON.stringify(fail, null, 2)];
  const pass = {
    item_id: itemId,
    verdict: 'PASS',
    findings: [],
    gates_run: gates,
    document_complete: !step,
    deferred_checks: [{ title: 'Each provider calls the report tool', whyDeferred: 'Needs a rebuilt app and a live session on each provider.' }],
    criteria_total: 6,
    not_checked: [],
  };
  return [(step ? 'A step' : 'A plan') + ' that passes with one deferred check (a PASS with nothing deferred leaves `deferred_checks` out):', '', JSON.stringify(pass, null, 2), '',
    'A plan that fails, with a code finding and an environment finding:', JSON.stringify(fail, null, 2)];
}
