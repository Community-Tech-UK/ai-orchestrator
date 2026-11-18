import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_CHANGE_EVENTS } from './plan-queue-history-store';
import { UNDO_DIRECT_CHANGE_REFUSAL } from './plan-queue-direct-changes';
import { coordinator, fake, git, implement, itemIdOf, pass, store, waitForRun, writeDoc } from './plan-queue-coordinator.test-helpers';
import { landing } from './plan-queue-coordinator.test-mocks';

// The stand-ins every coordinator spec installs, and the shared fixture: see the two modules imported below.
vi.mock('./plan-queue-gate-receipts', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withScriptedGates(await original()));
vi.mock('./plan-queue-landing', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withLandingHooks(await original()));
vi.mock('../workspace/git/worktree-integration', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withPromotionHook(await original()));

const OLD_STRIP = 'const label = name;\nconst figure = worst;\nrender(label, figure);\n';
const NEW_STRIP = 'const label = code;\nconst figure = perAccount;\nrender(label, figure, accounts);\n';

/** A queue landing set up the strip; James then changed it directly on main, after the plan was written. */
function jamesChangedTheStripOnMain(): string {
  writeFileSync(join(git(['rev-parse', '--show-toplevel']), 'strip.ts'), OLD_STRIP);
  git(['add', '-A']);
  git(['commit', '-q', '--no-verify', '-m', 'Plan: strip (Step 1)\n\nLanded by Plan Queue after 1 verification round(s).']);
  writeFileSync(join(git(['rev-parse', '--show-toplevel']), 'strip.ts'), NEW_STRIP);
  git(['add', '-A']);
  git(['commit', '-q', '--no-verify', '-m', 'Show codes and one figure per account']);
  return git(['rev-parse', 'HEAD']);
}

/** A plan from before James's change that still describes the old strip. */
function stalePlan(): void {
  writeDoc('docs/plans/2026-01-01-strip_spec_planned.md', '# Spec\n\n**Plan:** [plan](./2026-01-01-strip_plan.md)\n');
  writeDoc('docs/plans/2026-01-01-strip_plan.md', '# Plan\n\n**Spec:** [spec](./2026-01-01-strip_spec_planned.md)\n\n- [ ] Show names and the worst figure in `strip.ts`.\n');
}

/** Worker: does its own work and, unless told to keep James's change, follows the stale plan back to the old strip. */
function followsTheStalePlan(): void {
  fake.scripts.worker = async (instance, message, f) => {
    await implement(instance, message, f);
    const told = `${instance.config.initialPrompt ?? ''}\n${message}`.includes('Keep that change (Resume): the worker puts back what that commit did');
    writeFileSync(join(instance.workingDirectory!, 'strip.ts'), told ? NEW_STRIP : OLD_STRIP);
  };
}

async function parkedForUndoingJames() {
  const direct = jamesChangedTheStripOnMain();
  stalePlan();
  followsTheStalePlan();
  const parent = fake.addParent();
  const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
  await waitForRun(run.id);
  const item = coordinator.getRunDto(run.id)!.items[0]!;
  return { direct, parentId: parent.id, runId: run.id, item };
}

describe('Plan Queue landing never undoes a change made directly on main', { timeout: 40_000 }, () => {
  it('tells the worker which direct changes to keep, then parks a job that undoes one, landing nothing', async () => {
    const { direct, item } = await parkedForUndoingJames();

    const worker = fake.created.find((instance) => instance.role === 'worker')!;
    expect(worker.config.initialPrompt).toContain('<direct_changes>');
    expect(worker.config.initialPrompt).toContain(`${direct.slice(0, 9)}`);
    expect(worker.config.initialPrompt).toContain('"Show codes and one figure per account": strip.ts');
    expect(worker.config.initialPrompt).toContain('Harness refuses to land a job that undoes one.');

    expect(item).toMatchObject({ state: 'parked', parkReason: 'undoes-direct-change' });
    expect(item.detail).toContain('made directly on main on ');
    expect(item.detail).toContain('("Show codes and one figure per account") in strip.ts');
    expect(git(['rev-parse', 'main'])).toBe(direct);
    expect(git(['show', 'main:strip.ts'])).toBe(NEW_STRIP.trimEnd());
    expect(store.history.directChangeFingerprints(item.id, 'found')).toHaveLength(1);
  });

  it('refuses Land anyway from any session, and lands when James chooses the job\'s version on the page', async () => {
    const { parentId, runId, item } = await parkedForUndoingJames();

    await expect(coordinator.control({ action: 'land-anyway', itemId: item.id }, parentId)).rejects.toThrow(UNDO_DIRECT_CHANGE_REFUSAL);
    // Any other session, such as the Set aside agent, is refused the same way before any other check.
    await expect(coordinator.control({ action: 'land-anyway', itemId: item.id }, 'set-aside-agent')).rejects.toThrow(UNDO_DIRECT_CHANGE_REFUSAL);
    expect(coordinator.getRunDto(runId)!.items[0]!.state).toBe('parked');

    // main moves between James's choice and the landing: the approval is tied to the lines, not the branch head.
    landing.baseMovesOnce = () => {
      writeFileSync(join(git(['rev-parse', '--show-toplevel']), 'unrelated.txt'), 'other work\n');
      git(['add', 'unrelated.txt']);
      git(['commit', '-q', '--no-verify', '-m', 'Unrelated direct work']);
    };
    await coordinator.control({ action: 'land-anyway', itemId: item.id });
    await coordinator._whenSettledForTesting();

    const landed = coordinator.getRunDto(runId)!.items[0]!;
    expect(landed.state).toBe('landed');
    expect(git(['show', 'main:strip.ts'])).toBe(OLD_STRIP.trimEnd());
    expect(git(['show', 'main:unrelated.txt'])).toBe('other work');
    // The checker passed it, so it lands as a checked job: the plan closes and nothing says it skipped its checks.
    expect(landed.detail ?? '').not.toContain('without a verifier PASS');
    expect(git(['show', 'main:docs/plans/2026-01-01-strip_plan_completed.md'])).toContain('# Plan');
    expect(store.history.directChangeFingerprints(item.id, 'approved')).toEqual(store.history.directChangeFingerprints(item.id, 'found'));
    expect(store.history.listEvents(item.id).some((event) => event.reason === DIRECT_CHANGE_EVENTS.approved)).toBe(true);
  });

  it('Resume keeps the change: the next worker hears why it parked, keeps it, and the job lands', async () => {
    const { runId, item } = await parkedForUndoingJames();

    await coordinator.control({ action: 'resume-item', itemId: item.id });
    await waitForRun(runId);

    const resumed = coordinator.getRunDto(runId)!.items[0]!;
    expect(resumed.state).toBe('landed');
    expect(git(['show', 'main:strip.ts'])).toBe(NEW_STRIP.trimEnd());
    expect(git(['log', '-1', '--format=%s', 'main'])).toBe('Plan: 2026-01-01-strip_plan');
    expect(execFileSync('git', ['show', 'main:2026-01-01-strip_plan.feature.txt'], { cwd: git(['rev-parse', '--show-toplevel']), encoding: 'utf8' })).toBe('built 2026-01-01-strip_plan\n');
  });

  it('puts a direct change made while the job runs into its next prompt', async () => {
    stalePlan();
    let landedMidJob = '';
    fake.scripts.worker = async (instance, message, f) => {
      await implement(instance, message, f);
      if (landedMidJob) return;
      // James changes the strip on main while the first worker turn is still running.
      landedMidJob = jamesChangedTheStripOnMain();
    };
    let checks = 0;
    fake.scripts.verifier = async (instance, message, f) => {
      if (++checks > 1) return pass(instance, message, f);
      coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'FAIL', gates_run: [], document_complete: true, need_james: [], not_checked: [],
        findings: [{ severity: 'high', kind: 'code', confidence: 90, summary: 'The strip should show names.' }] });
    };
    const parent = fake.addParent();
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const worker = fake.created.find((instance) => instance.role === 'worker')!;
    expect(worker.config.initialPrompt).not.toContain('<direct_changes>');
    const fix = fake.inputs.find((input) => input.instanceId === worker.id && input.message.includes('An independent verifier failed your work'));
    expect(fix?.message).toContain(`${landedMidJob.slice(0, 9)}`);
    expect(fix?.message).toContain('If fixing a finding would undo a change listed under direct_changes, leave it');
    expect(coordinator.getRunDto(run.id)!.items[0]!.state).toBe('landed');
  });

  it('covers only the lines James was shown: a different set found at landing parks the job again', async () => {
    const { runId, item } = await parkedForUndoingJames();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // As if James had been shown a different undo than the one this landing finds.
    store.history.recordDirectChangeFingerprints(store.getItem(item.id)!, 'found', ['ffffffffffffffff']);

    await coordinator.control({ action: 'land-anyway', itemId: item.id });
    await coordinator._whenSettledForTesting();

    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'undoes-direct-change' });
    expect(git(['show', 'main:strip.ts'])).toBe(NEW_STRIP.trimEnd());
  });

  it('parks a plain Land anyway of a job set aside for another reason when it undoes a direct change', async () => {
    jamesChangedTheStripOnMain();
    stalePlan();
    followsTheStalePlan();
    fake.scripts.verifier = (instance) => {
      coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'FAIL', gates_run: [], document_complete: true, need_james: [], not_checked: [],
        findings: [{ severity: 'high', kind: 'needs-human', confidence: 90, summary: 'James must approve the wording.', missing: 'James\'s approval of the wording' }] });
    };
    const parent = fake.addParent();
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    const item = coordinator.getRunDto(run.id)!.items[0]!;
    expect(item).toMatchObject({ state: 'parked', parkReason: 'needs-james' });

    await coordinator.control({ action: 'land-anyway', itemId: item.id });
    await coordinator._whenSettledForTesting();

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'undoes-direct-change' });
    expect(git(['show', 'main:strip.ts'])).toBe(NEW_STRIP.trimEnd());
  });
});
