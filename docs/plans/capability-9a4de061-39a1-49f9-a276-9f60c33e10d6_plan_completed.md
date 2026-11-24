# Capability repair 9a4de061-39a1-49f9-a276-9f60c33e10d6

## Status

On main: yes (this landing commit)
Active; code done, link now live, ready for the checker's runtime probe. Branch `queue/capability-9a4de061-39a1-49f9-ca32cb`: (1) source-presence preflight before re-sending a parked original blocked on a `setup` gap; (2) `adoptOwnerRun` links an owner-started `capability-<repair id>_plan.md` item (running/paused run, not landing/landed, no PASS) to the repair so the probe and original rerun attach to it. The same code was landed on main by hand on 23 Nov (`7cabf1e16`, no source difference from this branch).
Round 7 (24 Nov): the running coordinator now has (2): `plan_queue_status` for run 3b0741d0 shows repair 9a4de061 `running` with repair run 04acb509 and this item `working`, detail "The repository owner is implementing this repair in their own queue run". So the park blocker is cleared. 63 capability/source-presence tests, typecheck, spec typecheck and lint pass.
Open: the checker reports the runtime probe through `plan_queue_report_capability_probe` (livetest section 3); after landing the coordinator reruns the original (section 2); section 1 is the live source-presence check. Evidence: `..._history.md` rounds 5-7.

## Refined design (this round)

Reproduction (code path, no app needed): `PlanQueueCapabilityService.reconcileOne` → `hooks.retryOrigin` → `retryCapabilityOrigin` resumes a parked `needs-setup` original with no look at its checkout. A run started in a parent checkout with no application source (communitytech) has an empty gate list (`defaultRunConfigFor`), so `assertRunReady` cannot catch it; the resumed worker reports the same `setup` gap and the cycle repeats.

Change: `src/main/plan-queue/plan-queue-source-presence.ts` (project-file scan: root plus one folder deep) used by `retryCapabilityOrigin` in `plan-queue-capability-control.ts`. When the original is still parked and any waiting check was reported as `setup` and the run's checkout has no project files, the retry throws a plain-language reason naming the application repository. `reconcile` already turns a throw after landing into: repair held for owner, one parent notice, no retry storm. The owner's explicit resume of the original is the override. Capability-class gaps, unparked items and checkouts with source are untouched. Dedupe of repairs (identity key), parent-only authorisation and account rules are unchanged.

Owner-run link (round 3): `PlanQueueCapabilityService.adoptOwnerRun` runs at the start of each `reconcile` for an unlinked repair whose gap names another repository. It matches an item in a running or paused run on that repository whose plan file is `capability-<repair id>_plan.md`, not discarded or skipped, not landing or landed, with no PASS verdict (a PASS given before the link never had to carry the runtime probe) and not already some repair's item, then saves `repairRunId`, `repairItemId`, `ownerRun: true`. `ownerRun` stops `reconcileOne` pausing, resuming or cancelling that run. `reportGap` treats a linked item like a repair run (no nested repair).

Acceptance: spec `plan-queue-source-presence.spec.ts` (scan) and cases in `plan-queue-capability-service.spec.ts` (parent-only held, not resumed, notified once; source present resumes; capability gap unaffected; owner resume after hold still works).

## Scope

Origin repository: /Users/suas/work/communitytech
Requested implementation repository: /Users/suas/work/orchestrat0r/ai-orchestrator
Owner handoff required (done, see below; the queue links the owner's run, section Refined design). Do not implement this control in the origin repository or edit the requested repository without its owner’s authority.

**Owner authority:** James authorised building this repair here on 20 November 2026 ("Build it in the projects then", "just fix shit and move forwards"), so the owner handoff is done: this repository's Plan Queue run is the owner. Copied from the origin repository's plan, which stays there as the record of where it came from.
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "source-repository-verification-handoff",
  "check": "Implement demonstrated AIO defects and meaningful regressions; run focused and canonical gates; fresh independent acceptance.",
  "requiredAction": "Provide an owner-coordinated source-repository verification handoff. This worker is confined to a parent checkout with neither application; existing application owners must qualify their actual source and return evidence linked to the original acceptance check.",
  "platform": "macos",
  "provider": "codex",
  "classification": "setup",
  "attempts": [
    {
      "operation": "Inspect assigned branch, merge base, tracked source and application entry points",
      "observedAt": 1795167872542,
      "result": "Assigned branch is queue/plan-queue-repair-and-completi-7eebf2 at f7566e7. All 353 tracked files include no application package manifest. package.json, apps/desk/package.json, work-finding and the Queue hold implementation path are absent. Base comparison contains evidence artifacts only."
    },
    {
      "operation": "Check actual application repository locations without modifying their checkouts",
      "observedAt": 1795167872723,
      "result": "Both /Users/suas/work/orchestrat0r/ai-orchestrator and /Users/suas/work/communitytech/work-finding exist as Git repositories with package manifests. Their existence is not test execution or source acceptance. Every code change for this assignment must stay in the parent worktree."
    },
    {
      "operation": "Inspect current supported Queue status and source-repository controls",
      "observedAt": 1795167932326,
      "result": "Supported status reports this item working at round 0 in /Users/suas/work/communitytech, with no linked capability repair. plan_queue_start supports choosing a registered workspace for a new run; capability repair authorisation is parent-only and limited to its own repository. Neither control authorises this assigned worker to edit another repository or take over existing application carriers."
    }
  ],
  "alternative": "Use existing application-scoped carriers through their owning coordinator and reuse supported workspace controls. Copying source, running tests against another owner's mutable checkout, creating competing workers, or claiming parent evidence is application verification would not satisfy the check.",
  "expectedResult": "The owner resolves source scope without disturbing existing workers; application-source checks run on identified source in the proper repositories, and the original item receives linked independent evidence before its acceptance check can close.",
  "implementation": "Bounded owner handoff in the Queue repository: first reconcile this original check with the existing application-scoped carriers and supported workspace selection. Establish durable prerequisite/evidence linkage and a source-presence preflight so a parent-only worker is not sent repeatedly to run absent application gates. Reuse existing controls; implement only a demonstrated missing handoff/preflight behavior, with regressions for wrong-repository assignment, retained owners, no duplicate carriers, and propagation of failed checks. Preserve parent-only authorisation, account rules and all original acceptance criteria. Do not reimplement historical application repairs or mutate production. A fresh checker must prove the handoff and then recheck the original acceptance against current application evidence.",
  "repairRepository": "/Users/suas/work/orchestrat0r/ai-orchestrator"
}
</capability_evidence>

## Implementation and acceptance

- [ ] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [ ] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [ ] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [ ] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Implement demonstrated AIO defects and meaningful regressions; run focused and canonical gates; fresh independent acceptance.",
  "expectedResult": "The owner resolves source scope without disturbing existing workers; application-source checks run on identified source in the proper repositories, and the original item receives linked independent evidence before its acceptance check can close."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.

> Closure history: `capability-9a4de061-39a1-49f9-a276-9f60c33e10d6_plan_history_8f4e4fd926fd87823142b515eb9fcd4ce4152b98b51faa758b999522b7ee9ecd_completed.md`.
