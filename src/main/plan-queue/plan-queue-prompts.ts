/**
 * Plan Queue prompts — worker, fix round, conflict, resume, verifier, triage.
 *
 * Provider-neutral (no Claude-only tool names), per
 * docs/prompt-engineering-house-style.md: role and goal first, interpolated
 * repository or agent text inside named delimiters marked as data, the task and
 * output contract last. Every completion signal is an MCP tool call handled by
 * code; nothing here asks the model to print a verdict for parsing.
 */

import * as path from 'path';
import type { PlanQueueFinding, PlanQueueKind } from '@contracts/schemas/plan-queue';
import type { PlanQueueItem } from './plan-queue.types';

export const VERDICT_TOOL = 'plan_queue_report_verdict';
export const TRIAGE_TOOL = 'plan_queue_report_triage';

const RUNBOOK_RELATIVE = 'docs/plans/livetest-campaign-runbook.md';
const MAX_DATA_CHARS = 12_000;

/** Wrap untrusted text in a named delimiter, neutralising any closing tag inside it. */
function dataBlock(tag: string, text: string): string {
  const safe = text.slice(0, MAX_DATA_CHARS).replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

/**
 * Isolated dev-app environment for one livetest item, derived from its id so
 * it is stable across restarts and distinct between items.
 */
export function livetestEnvironmentFor(item: Pick<PlanQueueItem, 'id'>): { userDataPath: string; debugPort: number } {
  let hash = 0;
  for (const char of item.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const suffix = item.id.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
  return { userDataPath: `/tmp/aio-lt-queue-${suffix}`, debugPort: 9500 + (hash % 400) };
}

interface ItemPromptContext {
  item: PlanQueueItem;
  kind: PlanQueueKind;
  repoRoot: string;
  worktreePath: string;
  /** James's answer to a readiness question, when there was one. */
  answer?: string | null;
}

function documentRules(ctx: ItemPromptContext): string[] {
  return [
    `- Your document is \`${ctx.item.documentPath}\`. It lives in the ROOT checkout \`${ctx.repoRoot}\` and is not in your worktree. Read and edit it at that absolute path; never copy it into the worktree.`,
    `- Make every code change in your worktree \`${ctx.worktreePath}\`. It is on branch \`${ctx.item.branchName ?? 'unknown'}\`, cut from the base branch.`,
    '- Other files that git tracks (for example a shared register) are edited in the worktree like code. Untracked planning documents are edited in the root checkout at their absolute path.',
    '- Do not commit, stash, create or switch branches, or create worktrees. The queue coordinator commits your work to the branch for you.',
    '- Never rename your document to a `_completed` name. The coordinator does that after an independent verifier passes the work.',
  ];
}

export function buildWorkerPrompt(ctx: ItemPromptContext): string {
  const answer = ctx.answer
    ? ['', 'James answered a question about this document before work started:', dataBlock('james_answer', ctx.answer)]
    : [];
  if (ctx.kind === 'livetests') return buildLivetestWorkerPrompt(ctx, answer);
  return [
    'You are a Plan Queue worker. Your goal is to implement one plan document completely and leave it ready for an independent verifier.',
    '',
    'Rules:',
    ...documentRules(ctx),
    '- Follow AGENTS.md in the repository. Read the plan, its linked spec and every file you change, with its callers and tests, before editing.',
    '- Run the targeted tests for what you changed and the repository\'s fast static checks (type-check and lint, as its AGENTS.md or README documents them). Do not run the full test suite; the verifier does that.',
    '- If the repository has generators whose output is committed (for example IPC or alias generators), run them so generated files are current in the worktree.',
    '- When a check genuinely needs a rebuilt app, a human or an external service, record it in a `_livetest.md` beside the plan, following the Live-Test Deferral rules in AGENTS.md.',
    ...answer,
    '',
    'Task: implement every unchecked item in the plan in your worktree. When the work is complete, update the plan\'s status and as-built notes (and the spec\'s, if it has one), then stop. Your turn ending is the signal that the work is ready for verification.',
  ].join('\n');
}

function buildLivetestWorkerPrompt(ctx: ItemPromptContext, answer: string[]): string {
  const env = livetestEnvironmentFor(ctx.item);
  return [
    'You are a Plan Queue livetest worker. Your goal is to run every open check in one livetest document against a live dev app and record honest, dated evidence.',
    '',
    'Rules:',
    ...documentRules(ctx),
    `- Read \`${path.join(ctx.repoRoot, RUNBOOK_RELATIVE)}\` in full first and follow it. Build and launch the dev app from your worktree.`,
    `- Isolate your dev app: set \`AIO_DEV_USER_DATA_PATH=${env.userDataPath}\` and use \`--remote-debugging-port=${env.debugPort}\`. Enable focus emulation before any DOM assertion.`,
    '- Record per-check evidence in the document as a new dated section. File every reproduced defect in the remediation register as the runbook describes.',
    '- Mark a check as needing James only for a real operator boundary (login, credential entry, a physical device, a destructive or release action, an unresolved product decision). State the exact reason for each.',
    '- Stop the dev app you launched before you finish.',
    ...answer,
    '',
    'Task: work through every open check in the document. When you have recorded evidence for each one, stop. Your turn ending is the signal that the evidence is ready for verification.',
  ].join('\n');
}

export function buildFixPrompt(round: number, maxRounds: number, findings: readonly PlanQueueFinding[]): string {
  const rendered = findings.length
    ? findings.map((f, i) => `${i + 1}. [${f.severity}, confidence ${f.confidence}] ${f.summary}${f.file ? ` (${f.file})` : ''}${f.evidence ? `\n   Evidence: ${f.evidence}` : ''}`).join('\n')
    : '(The verifier failed the work without listing findings. Re-check the plan\'s acceptance criteria and the canonical gates.)';
  return [
    `An independent verifier failed your work (verification round ${round} of ${maxRounds}). Its findings follow as data.`,
    '',
    dataBlock('verifier_findings', rendered),
    '',
    'Task: fix every finding in your worktree, re-run the targeted checks, update the document\'s as-built notes, then stop. The same rules as before apply: no commits, no branch changes, no `_completed` rename.',
  ].join('\n');
}

export function buildConflictPrompt(baseBranch: string, conflictFiles: readonly string[]): string {
  return [
    `The coordinator merged \`${baseBranch}\` into your branch and the merge has conflicts. The merge is still in progress in your worktree.`,
    '',
    dataBlock('conflicted_files', conflictFiles.join('\n')),
    '',
    'Task: resolve every conflict so both sides\' intent survives, remove all conflict markers, `git add` the resolved files, re-run the targeted checks, then stop. Do not commit and do not abort the merge; the coordinator finishes it.',
  ].join('\n');
}

export function buildGateFailurePrompt(command: string, output: string): string {
  return [
    'After the base branch was merged into your branch, a deterministic post-merge check failed.',
    '',
    dataBlock('failed_command', command),
    dataBlock('command_output', output),
    '',
    'Task: fix the cause in your worktree, re-run that command until it passes, then stop.',
  ].join('\n');
}

export function buildActiveDocumentsPrompt(paths: readonly string[]): string {
  return [
    'The coordinator could not land your work: your branch contains active planning documents, which are never committed.',
    '',
    dataBlock('active_documents', paths.join('\n')),
    '',
    'Your own document is closed by the coordinator after the verifier passes, and other planning documents stay untracked in the root checkout. Task: move any of these you still need to the same path in the root checkout, delete them from your worktree, then stop.',
  ].join('\n');
}

export function buildResumePrompt(ctx: ItemPromptContext, reason: string): string {
  return [
    `You are resuming a Plan Queue item. Earlier work on it is already committed on branch \`${ctx.item.branchName ?? 'unknown'}\`, which is checked out in your worktree. Reason for the resume: ${reason}.`,
    '',
    buildWorkerPrompt(ctx),
    '',
    'Start by reading the document\'s as-built notes and `git log` / `git diff` against the base branch in your worktree to see what is already done. Continue from there rather than starting again.',
  ].join('\n');
}

interface VerifierPromptContext {
  item: PlanQueueItem;
  kind: PlanQueueKind;
  repoRoot: string;
  worktreePath: string;
  baseBranch: string;
  gates: readonly string[];
}

export function buildVerifierPrompt(ctx: VerifierPromptContext): string {
  const livetest = ctx.kind === 'livetests';
  const criteria = livetest
    ? [
        '- Every check claimed as passing has current, dated evidence in the document that actually demonstrates it.',
        '- Every reproduced defect was filed in the remediation register; none was silently dropped or downgraded.',
        '- For every check left as needing James, classify it: `real` (a genuine physical, identity or decision boundary), `policy-gated` (blocked only by a setting or policy that could be relaxed) or `stale` (the reason no longer holds; it should be retried).',
        '- The document may only be closed (`documentComplete: true`) when every check in it passes with evidence.',
      ]
    : [
        '- Every item in the plan and every acceptance criterion in the plan and its spec is implemented, wired into the running code path, and covered by tests.',
        '- Architecture fits the existing code; no dead code, no placeholder, no test weakened to pass.',
        '- Security, async/state handling and error paths are correct.',
        '- Anything deferred to a `_livetest.md` genuinely needs a rebuilt app, a human or an external service.',
      ];
  return [
    'You are an independent Plan Queue verifier. Your goal is to judge, with fresh eyes, whether one document\'s work is genuinely complete. You did not do this work.',
    '',
    `- The document is \`${ctx.item.documentPath}\` in the root checkout \`${ctx.repoRoot}\`.`,
    `- The work is on branch \`${ctx.item.branchName ?? 'unknown'}\` in the worktree \`${ctx.worktreePath}\`. Review it with \`git diff $(git merge-base HEAD ${ctx.baseBranch})\` there.`,
    '- Do not edit, create or delete any tracked file, and do not commit. The coordinator compares the tree before and after your review and discards a verdict from a reviewer that changed it. Build output and caches that git ignores are fine.',
    '',
    'Judge against these criteria:',
    ...criteria,
    '',
    ...(ctx.gates.length
      ? ['Run these gates in the worktree, each separately, and record each exit code:', ...ctx.gates.map((gate) => `- \`${gate}\``)]
      : ['Run the repository\'s own documented verification commands (its AGENTS.md, README or package scripts) in the worktree, each separately, and record each exit code.']),
    '',
    `Task: finish by calling the \`${VERDICT_TOOL}\` tool exactly once with \`item_id\` "${ctx.item.id}". Use \`PASS\` only when every criterion holds and every gate exited 0. Each finding needs a severity (critical, high, medium or low), a confidence from 0 to 100, a one-sentence summary and concrete evidence, normally file:line. A PASS with no findings is valid after genuine scrutiny. Example call arguments:`,
    '',
    JSON.stringify({
      item_id: ctx.item.id,
      verdict: 'FAIL',
      findings: [{ severity: 'high', confidence: 90, summary: 'The retry path never resets the attempt counter.', file: 'src/main/example/retry.ts:42', evidence: 'attempts is incremented on line 42 and never cleared on success.' }],
      gates_run: [{ command: ctx.gates[0] ?? 'npm run lint', exitCode: 0 }],
      document_complete: false,
      ...(livetest ? { need_james: [{ check: 'Check 3: Face ID unlock', classification: 'real', reason: 'Needs a physical iPhone with enrolled biometrics.' }] } : {}),
    }, null, 2),
  ].join('\n');
}

export function buildTriagePrompt(runId: string, documents: readonly string[]): string {
  return [
    'You are the Plan Queue triage agent. Your goal is to decide, for each document below, whether an autonomous worker can start on it now or whether James must decide something first.',
    '',
    'The documents are listed as data. Read each one at its absolute path.',
    dataBlock('documents', documents.join('\n')),
    '',
    'For each document choose one disposition:',
    '- `ready` — a worker can implement or test it without a decision from James.',
    '- `needs-answer` — the document is awaiting review, has an open decision, depends on another unfinished plan, or is otherwise blocked on James. Give one plain-language question with 2 to 4 options; each option has a short `id` and a `label` saying what the queue will do. Include an option with id `skip` for leaving the document alone.',
    '- `skip` — the document should not be worked at all (for example it is superseded). Give the reason.',
    'A plan that is already fully implemented and only needs closing is `ready`: the worker will confirm and close it out.',
    '',
    `Task: call the \`${TRIAGE_TOOL}\` tool once with \`run_id\` "${runId}" and one record per document, then stop. Example call arguments:`,
    '',
    JSON.stringify({
      run_id: runId,
      records: [
        { documentPath: documents[0] ?? '/repo/docs/plans/2026-01-01-example_plan.md', disposition: 'ready' },
        {
          documentPath: '/repo/docs/plans/2026-01-02-other_plan.md',
          disposition: 'needs-answer',
          question: {
            question: 'The plan leaves the retention period open. Which should the worker implement?',
            options: [
              { id: 'thirty-days', label: 'Keep 30 days of history' },
              { id: 'skip', label: 'Leave this plan for now' },
            ],
          },
        },
      ],
    }, null, 2),
  ].join('\n');
}
