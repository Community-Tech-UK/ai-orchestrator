/** Machine checks, durable round memory and pinned criteria for the queue flow. */
import * as fs from 'node:fs/promises';
import { readDocumentReview, type DocumentReview } from './plan-queue-document-review';
import * as path from 'node:path';
import type { PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import { gitExec } from '../workspace/git/git-exec';
import { blockingGateReceipts, onlyTimedOut, type PlanQueueGateRunner, type PlanQueueGateReceipt } from './plan-queue-gate-receipts';
import { CHECK_HUNG_DETAIL, recordCheckTimeout } from './plan-queue-check-timeouts';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { readPlanPin, comparePinnedUnchecked, extractChecklistItems } from './plan-queue-plan-pins';
import { buildGateFailurePrompt, buildVerifierPrompt } from './plan-queue-prompts';
import { bounded, PLAN_BRIEF_BYTES, readPlanBrief } from './plan-queue-plan-extract';
import { decideNoProgress, documentContentSha256, progressFingerprint, recordRepeatedFindingObservation, repeatedFindingIds } from './plan-queue-progress';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { PlanQueueCheckGroups, type CheckGroupFlow } from './plan-queue-check-groups';
import { deferredPassProblems } from './plan-queue-deferred-checks';

type Preparation = { kind: 'ready' } | { kind: 'wait'; detail: string }
  | { kind: 'fix'; prompt: string; detail: string } | { kind: 'park'; detail: string; reason: 'no-progress' | 'round-limit' | 'check-hung' };

export class PlanQueueVerification {
  /** In-flight evidence lives until the round is recorded or its review stops. */
  private readonly receipts = new Map<string, PlanQueueGateReceipt[]>();
  private readonly checkedBases = new Map<string, string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly checkedDocuments = new Map<string, DocumentReview>();
  readonly groups: PlanQueueCheckGroups;
  constructor(private readonly host: PlanQueueFlowHost, private readonly gates: PlanQueueGateRunner, flow: CheckGroupFlow) {
    this.groups = new PlanQueueCheckGroups(host, gates, flow);
  }

  cancel(itemId: string): void { this.groups.cancel(itemId); this.controllers.get(itemId)?.abort(); }
  /** Called under the item lock once its review has stopped. */
  forgetResults(head: string): void { this.gates.forgetCommit(head); }
  forgetCheck(itemId: string): void { this.groups.forget(itemId); this.checkedBases.delete(itemId); this.checkedDocuments.delete(itemId); this.receipts.delete(itemId); }
  cancelAll(): void { this.groups.cancelAll(); for (const controller of this.controllers.values()) controller.abort(); }

  rememberWorkerClaim(item: PlanQueueItem, text: string): void {
    if (!text.trim()) return;
    this.host.history.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state,
      reason: 'worker-claim', detailHead: text, round: item.round, tokens: 0 });
  }

  stepBack(item: PlanQueueItem): string {
    const repeated = repeatedFindingIds(this.host.history.listVerdicts(item.id));
    return repeated.twice.size ? '\n\nThe same finding failed twice.\nReproduce it and find the cause before another fix.\nIf the finding is wrong, explain why with file:line evidence.' : '';
  }

  async pin(item: PlanQueueItem): Promise<void> {
    if (this.host.history.getPin(item.id)) return;
    const pin = await readPlanPin(item);
    if (!pin) throw new Error('The source document could not be read before starting work');
    this.host.history.recordPinIfAbsent(pin);
  }

  checkedBase(itemId: string): string {
    const base = this.checkedBases.get(itemId);
    if (!base) throw new Error('The checker has no prepared base commit.');
    return base;
  }

  async prepareGrouped(item: PlanQueueItem): Promise<Preparation | undefined> {
    const receipts = await this.groups.pendingReceipts(item);
    return receipts ? this.prepareChecks(item, receipts) : undefined;
  }

  prepare(item: PlanQueueItem): Promise<Preparation> { return this.prepareChecks(item, undefined); }

  private async prepareChecks(item: PlanQueueItem, grouped: PlanQueueGateReceipt[] | undefined): Promise<Preparation> {
    this.checkedDocuments.delete(item.id);
    const run = this.host.getRun(item.runId);
    const fingerprint = JSON.stringify(progressFingerprint(item.checkpointCommit, await documentContentSha256(item.sourceRef), item.round));
    const warned = this.host.history.listEvents(item.id).some(event => event.reason === 'no-progress-warning' && event.detailHead === fingerprint);
    const progress = await decideNoProgress(this.host.history.listVerdicts(item.id), item, warned);
    if (progress.kind === 'park') return { ...progress, reason: 'no-progress' };
    if (progress.kind === 'reprompt') {
      this.host.history.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state,
        reason: 'no-progress-warning', detailHead: fingerprint, round: item.round, tokens: 0 });
      return { kind: 'fix', prompt: progress.prompt, detail: 'Nothing changed since the last failed check.' };
    }
    if (!run.config.verifierGates.length) {
      this.receipts.set(item.id, []);
      this.checkedBases.set(item.id, await gitExec(['rev-parse', `refs/heads/${run.config.baseBranch}`], run.workspaceCwd));
      return { kind: 'ready' };
    }
    const controller = this.groups.controllerFor(item.id) ?? new AbortController();
    this.controllers.set(item.id, controller);
    try {
      const head = await gitExec(['rev-parse', 'HEAD'], item.worktreePath!);
      if (grouped && (grouped.some((receipt, index) => receipt.head !== head || receipt.command !== run.config.verifierGates[index])
        || !this.groups.pendingStillIntact(item.id))) return { kind: 'wait', detail: 'The work changed while checks ran; waiting to check it again.' };
      const baseSha = grouped?.[0]?.checkGroup?.baseTip ?? await gitExec(['rev-parse', `refs/heads/${run.config.baseBranch}`], run.workspaceCwd);
      if (!this.host.checksAdmitted(run)) return { kind: 'wait', detail: 'Checks are paused or the computer is busy.' };
      this.host.save({ ...this.host.getItem(item.id), detail: 'Running checks' });
      const input = { cwd: item.worktreePath!, head, commands: run.config.verifierGates,
        signal: controller.signal, baseSha, scope: run.workspaceCwd,
        onExecution: () => this.host.history.recordChecklistRun(item, [item.id]),
        withBaseline: <T>(action: (cwd: string) => Promise<T>) => this.host.worktrees.withBaseline(run.workspaceCwd, baseSha, action) };
      const receipts = grouped ?? this.gates.cached(input) ?? await this.groups.run(item, run, input) ?? await this.gates.run(input);
      controller.signal.throwIfAborted();
      if (await gitExec(['rev-parse', 'HEAD'], item.worktreePath!) !== head) {
        return { kind: 'wait', detail: 'The work changed while checks ran; waiting to check it again.' };
      }
      if (grouped) {
        const documentReview = await this.groups.confirmPending(item.id, grouped);
        if (!documentReview) return { kind: 'wait', detail: 'The work changed while checks ran; waiting to check it again.' };
        controller.signal.throwIfAborted();
        this.checkedDocuments.set(item.id, documentReview);
      }
      if (onlyTimedOut(receipts)) {
        if (recordCheckTimeout(this.host, item, receipts) >= 2) return { kind: 'park', reason: 'check-hung', detail: CHECK_HUNG_DETAIL };
        return { kind: 'wait', detail: 'The checks did not finish in time, which says nothing about the work. They will run again.' };
      }
      this.receipts.set(item.id, receipts);
      this.checkedBases.set(item.id, baseSha);
      const red = blockingGateReceipts(receipts).filter(receipt => !receipt.timedOut);
      if (!red.length) return { kind: 'ready' };
      const round = item.round + 1;
      const verdict: PlanQueueVerdict = { verdict: 'FAIL', findings: red.map(receipt => ({ severity: 'high', kind: 'code', confidence: 100,
        summary: `Harness's own gate run failed: ${receipt.command}`, evidence: receipt.tail })),
        gatesRun: receipts, documentComplete: false,
        needJames: [], notChecked: ['Independent review was not started because Harness checks did not pass.'] };
      await this.record(item, verdict);
      this.host.save({ ...this.host.getItem(item.id), round, verdict });
      if (round >= run.config.maxRounds) return { kind: 'park', reason: 'round-limit', detail: `Checks still fail after ${round} rounds: ${red[0].command}` };
      return { kind: 'fix', prompt: red.map(receipt => buildGateFailurePrompt(receipt.command, receipt.tail)).join('\n\n'),
        detail: 'Harness checks did not pass; the worker is fixing them.' };
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'wait', detail: 'Checks were stopped.' };
      throw error;
    } finally { this.controllers.delete(item.id); }
  }

  async record(item: PlanQueueItem, reported: PlanQueueVerdict): Promise<PlanQueueVerdict> {
    const receipts = this.receipts.get(item.id) ?? [];
    const head = item.worktreePath ? await gitExec(['rev-parse', 'HEAD'], item.worktreePath) : item.checkpointCommit;
    const configured = this.host.getRun(item.runId).config.verifierGates;
    const red = blockingGateReceipts(receipts);
    const missing = configured.length > 0 && (receipts.length !== configured.length || receipts.some(receipt => receipt.head !== head));
    const currentReview = await readDocumentReview(item.sourceRef);
    const documentHash = currentReview.documentSha256;
    const checkedHash = this.checkedDocuments.get(item.id);
    const changedDocument = !documentHash || (checkedHash !== undefined && JSON.stringify(checkedHash) !== JSON.stringify(currentReview));
    const machineProblem = changedDocument ? 'The source document changed while the checker was reviewing it.'
      : red.length || missing ? `Harness's own gate run failed: ${red[0]?.command ?? 'missing checks for the current commit'}`
      : checkedHash === undefined ? 'The checker did not record which source document it reviewed.' : null;
    // A deferred check (plans only) must be in the worker's report and written down beside the plan, or the PASS cannot stand.
    const deferredProblems = this.host.getRun(item.runId).kind === 'plans'
      ? await deferredPassProblems(reported, item.workerReport, item.sourceRef) : [];
    const problems = machineProblem ? [{ severity: 'high' as const, kind: 'code' as const, confidence: 100, summary: machineProblem }] : deferredProblems;
    const validated: PlanQueueVerdict = reported.verdict === 'PASS' && problems.length
      ? { ...reported, verdict: 'FAIL', documentComplete: false, findings: [...reported.findings, ...problems] }
      : reported;
    const gatesRun = receipts.map(({ failureKeyCounts: _keys, ...receipt }) => receipt);
    const verdict = { ...validated, ...(receipts.length ? { gatesRun } : {}) };
    // A review describes the bytes the checker saw. Storing the replacement
    // document here would make that fresh input look like an unchanged failure.
    const reviewedHash = checkedHash?.documentSha256 ?? documentHash;
    this.host.history.recordVerdict({ itemId: item.id, runId: item.runId, round: item.round + 1, verdict: verdict.verdict,
      findings: verdict.findings, gatesRun: verdict.gatesRun,
      notChecked: verdict.notChecked ?? [], worktreeHead: head, documentSha256: reviewedHash, ...(checkedHash ? { documentReview: checkedHash } : {}) });
    this.forgetCheck(item.id);
    recordRepeatedFindingObservation(this.host.history, item, item.round + 1);
    return verdict;
  }

  async prompt(item: PlanQueueItem, run: PlanQueueRun, baseBranch: string): Promise<string> {
    const rows = this.host.history.listVerdicts(item.id);
    const last = rows.at(-1)?.worktreeHead;
    const diff = last ? await gitExec(['diff', `${last}..HEAD`, '--stat'], item.worktreePath!) : '';
    const events = this.host.history.listEvents(item.id);
    const earlier = rows.filter(row => row.verdict === 'FAIL').map(row => ({ round: row.round, findings: row.findings,
      status: 'unconfirmed, re-check', workerClaim: events
        .find(event => event.reason === 'worker-claim' && event.round === row.round)?.detailHead ?? 'No claimed fix was recorded.' }));
    const pin = this.host.history.getPin(item.id);
    const currentBytes = await fs.readFile(item.sourceRef);
    const current = currentBytes.toString('utf8');
    const relative = path.relative(run.workspaceCwd, item.sourceRef);
    const docDiff = item.baseCommit && !relative.startsWith('..')
      ? await gitExec(['diff', `${item.baseCommit}..HEAD`, '--', relative], item.worktreePath!) : '';
    const receipts = this.receipts.get(item.id) ?? [];
    if (this.checkedDocuments.has(item.id) && receipts[0]?.checkGroup) {
      // Selection and the read-only snapshot await after preparation. Recheck here,
      // retaining the original group source identity rather than capturing its replacement.
      if (!await this.groups.confirmPending(item.id, receipts)) {
        throw new Error('The work or source document changed before its checker started; it will be checked again.');
      }
    } else this.checkedDocuments.set(item.id, await readDocumentReview(item.sourceRef));
    return buildVerifierPrompt({ item, kind: run.kind, repoRoot: run.workspaceCwd, worktreePath: item.worktreePath!, baseBranch,
      gates: run.config.verifierGates, receipts: this.receipts.get(item.id) ?? [],
      // The checker reads the plan's Status and open work and a change summary, then sections by line range.
      diffStat: bounded(await gitExec(['diff', '--stat', `${baseBranch}...HEAD`], item.worktreePath!), PLAN_BRIEF_BYTES, '[Change summary truncated. Run git diff --stat for the rest.]'),
      ...(run.kind === 'plans' ? { brief: await readPlanBrief(item.sourceRef, item.section) } : {}),
      earlierRounds: rows.length ? JSON.stringify({ earlier, diffSinceLastCheck: diff }) : undefined,
      documentChanges: pin ? JSON.stringify({ originalHash: pin.documentSha256, originalUnchecked: pin.unchecked,
        changes: comparePinnedUnchecked(pin.unchecked, extractChecklistItems(current, 'all')), diff: docDiff }) : undefined });
  }
}
