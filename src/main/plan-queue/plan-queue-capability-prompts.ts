import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { PlanQueueItem } from './plan-queue.types';

export function capabilityRules(repoRoot?: string, remote = false): string[] {
  const runbook = repoRoot && path.join(repoRoot, 'docs/plans/livetest-capability-repair-runbook.md');
  return [
    '- Treat a missing tool, stale build, unavailable test fixture or absent test control as a capability gap to investigate, not automatically a human step. Check current tool discovery, health and safe alternatives, recording recent, redacted observations.',
    remote
      ? '- This computer has no Harness tools. Put investigated gaps in `capability_gaps` in your existing turn report file (up to eight); the coordinator authenticates and retains them before clearing that report. End the turn with the original checks open.'
      : '- Report investigated gaps with `plan_queue_report_capability_gap` using your item_id (triage uses run_id and the exact document_path). The current assigned worker, triage agent or independent checker must report its own evidence. For a technical gap, keep its original check open and end your turn after acceptance; Harness saves the work and creates a linked bounded repair plan.',
    '- Gap fields: capabilityKey (stable lowercase slug), check (exact acceptance text), requiredAction, platform (macos/windows/linux/any), provider (lowercase slug), classification (capability/setup/human-authority/human-input), attempts (operation, observedAt as current Unix milliseconds, result), alternative, expectedResult and implementation (concrete bounded proposal). Report no secrets or raw session contents. Capture alone grants no extra authority.',
    `- Example gap payload showing the complete format; replace it with your actual observations: ${JSON.stringify({ capabilityKey: 'owned-test-session', check: 'Create an owned test session', requiredAction: 'Create a disposable restricted session', platform: 'macos', provider: 'codex', classification: 'capability', attempts: [{ operation: 'Discover owned session creation tools', observedAt: Date.now(), result: 'No creation control was available.' }], alternative: 'Production sessions are outside the authorised test scope.', expectedResult: 'The session responds and is removed after the check.', implementation: 'Extend the existing test-owned session interface; test ownership checks and cleanup.' })}`,
    '- Existing user authority must cover implementation in the source repository. The ordinary owning parent can enable it with `plan_queue_authorize_capability_repairs`; workers cannot. Cross-project scope stays with its owner. Repairs cannot create another repair run; report the further prerequisite and stop safely.',
    '- If the missing control belongs to Harness or another project, put its repository path on the computer running the queue in repairRepository; other paths are refused. This requests an owner handoff, never permission to edit another project. Do not change the blocked application to work around it.',
    ...(runbook && existsSync(runbook) ? [`- For this Harness checkout, also read the operational runbook at ${runbook}.`] : []),
  ];
}

export function capabilityCheckerRules(item: PlanQueueItem, repoRoot: string): string[] {
  const launcher = existsSync(path.join(repoRoot, 'scripts/remote-checks/dev-app.js'));
  return [
    ...capabilityRules(repoRoot),
    `- Read plan_queue_status for run_id "${item.runId}". When this item retries checks linked to a repair, verify each exact check and call plan_queue_report_capability_check with item_id "${item.id}", repair_id, exact check text and concrete evidence before your normal verdict. A passing check may resolve even when another check in the document still needs genuine human action.`,
    ...(launcher ? ['- If this is a capability repair plan, independent PASS requires a current runtime probe. In the reviewed worktree, read the checkpoint tree with `git rev-parse HEAD^{tree}`. Start the authorised remote copy with the repository dev-app launcher’s `--checked-tree` option. Preserve its actual `AIO_DEV_APP_RECEIPT` JSON; do not manufacture or substitute the expected tree when it differs.',
    '- Read application name, version and isPackaged from the running copy and execute the exact new control. Stop the owned copy afterward. Write an ignored, bounded JSON receipt in your worktree. Its launch field contains the actual launcher object; runtime contains application, version and isPackaged; operation and result contain the exact probe and observed outcome; observedAt contains Unix milliseconds. No tracked file edits. Hash the receipt bytes with SHA-256, then call plan_queue_report_capability_probe using that relative receiptPath, receiptSha256, computer, runtimeBuild (actual launch tree), testedTree (reviewed checkpoint tree), observedAt, operation and result. The tool retains the evidence before cleanup. If these do not match, keep the repair unverified; never claim its original check passed.']
      : ['- This repository has no supported checkpoint-bound Harness runtime launcher. A capability repair here must wait for an authorised runtime receipt route or an owner handoff; do not invent a launcher, build identity or successful probe. Ordinary non-repair reviews still follow this project’s own checks.']),
  ];
}
