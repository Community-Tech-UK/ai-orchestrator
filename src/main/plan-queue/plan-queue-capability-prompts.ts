import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { PlanQueueItem } from './plan-queue.types';

/**
 * Whether a repository has Harness's checkpoint-bound dev-app launcher, the only route to a runtime probe receipt.
 * Only such a repository's repairs need one; elsewhere a probe cannot be produced, so it is not asked for.
 */
export function hasHarnessRuntimeLauncher(repoRoot: string): boolean {
  return existsSync(path.join(repoRoot, 'scripts/remote-checks/dev-app.js'));
}

export function capabilityRules(repoRoot?: string, remote = false): string[] {
  const runbook = repoRoot && path.join(repoRoot, 'docs/plans/livetest-capability-repair-runbook.md');
  return [
    '- Investigate missing tools, stale builds, fixtures and test controls before asking a human. Check tool discovery, health and safe alternatives; record recent, redacted observations.',
    remote
      ? '- This computer has no Harness tools. Put investigated gaps in `capability_gaps` in your existing turn report file (up to eight); the coordinator authenticates and retains them before clearing that report. End the turn with the original checks open.'
      : '- Report your own evidence through `plan_queue_report_capability_gap`: item_id, or run_id and exact document_path for triage. After acceptance of a technical gap, keep the original check open and end your turn; Harness saves your work and creates a linked bounded repair plan.',
    '- Follow the gap schema below: stable lowercase capabilityKey/provider, exact acceptance text in check, current Unix milliseconds in observedAt, and a bounded implementation proposal. Other platform values: windows/linux/any; other classifications: setup/human-authority/human-input. Include no secrets or raw session contents.',
    `- Complete gap example; use your actual observations: ${JSON.stringify({ capabilityKey: 'owned-test-session', check: 'Create an owned test session', requiredAction: 'Create a disposable restricted session', platform: 'macos', provider: 'codex', classification: 'capability', attempts: [{ operation: 'Find owned session controls', observedAt: Date.now(), result: 'No creation control found.' }], alternative: 'Production sessions are outside test authority.', expectedResult: 'Session responds, then is removed.', implementation: 'Extend the test-owned session interface; test ownership and cleanup.' })}`,
    '- Capture grants no authority. Implementation needs existing user authority for the source repository; only the owning parent can enable `plan_queue_authorize_capability_repairs`. Repairs cannot create another repair run: report the prerequisite and stop.',
    '- For a control owned by Harness or another project, give its repository path on the computer running the queue in repairRepository (other paths are refused) for owner handoff, not permission to edit there. Do not work around missing Harness controls by changing the blocked application.',
    ...(runbook && existsSync(runbook) ? [`- For this Harness checkout, also read the operational runbook at ${runbook}.`] : []),
  ];
}

/**
 * `ownsRepair` is whether the Queue linked this very item to a capability repair. Only such an item can report a probe
 * (`reportProbe` refuses any other), so only it is asked for one; a plan that merely describes or changes the repair
 * feature is reviewed like any other job.
 */
export function capabilityCheckerRules(item: PlanQueueItem, repoRoot: string, ownsRepair: boolean): string[] {
  const launcher = hasHarnessRuntimeLauncher(repoRoot) && ownsRepair;
  return [
    ...capabilityRules(repoRoot),
    `- Read plan_queue_status for run_id "${item.runId}". When this item retries checks linked to a repair, verify each exact check and call plan_queue_report_capability_check with item_id "${item.id}", repair_id, exact check text and concrete evidence before your normal verdict. A passing check may resolve even when another check in the document still needs genuine human action.`,
    ...(launcher ? ['- This item is a Queue-linked capability repair, so independent PASS requires a current runtime probe. In the reviewed worktree, read the checkpoint tree with `git rev-parse HEAD^{tree}`. Start the authorised remote copy with the repository dev-app launcher’s `--checked-tree` option. Preserve its actual `AIO_DEV_APP_RECEIPT` JSON; do not manufacture or substitute the expected tree when it differs.',
    '- Read application name, version and isPackaged from the running copy and execute the exact new control. Stop the owned copy afterward. Write an ignored, bounded JSON receipt in your worktree. Its launch field contains the actual launcher object; runtime contains application, version and isPackaged; operation and result contain the exact probe and observed outcome; observedAt contains Unix milliseconds. No tracked file edits. Hash the receipt bytes with SHA-256, then call plan_queue_report_capability_probe using that relative receiptPath, receiptSha256, computer, runtimeBuild (actual launch tree), testedTree (reviewed checkpoint tree), observedAt, operation and result. The tool retains the evidence before cleanup. If these do not match, keep the repair unverified; never claim its original check passed.']
      : [ownsRepair
        ? '- This repository has no Harness runtime launcher, so a capability repair here needs no runtime probe or launch receipt, even where its plan asks for one. Review it against its plan and this project’s own checks like any other job; do not report the missing launcher as a capability gap.'
        : '- This item is not a Queue-linked capability repair, so it needs no runtime probe or launch receipt, even if its plan mentions one; `plan_queue_report_capability_probe` refuses it. Review it like any other job; do not report the missing probe as a finding or capability gap.']),
  ];
}
