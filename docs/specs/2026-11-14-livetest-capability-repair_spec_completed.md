# Live-test capability repair

## Status

On main: yes (this landing commit)
Approved by James in document review `dr_4581e84b-3c75-42cb-81a2-56d62fbf2dc1`: all ten review sections, including intended behaviour, investigation, repair workflow, remote controls, acceptance, the ten existing requests and additional parked jobs. Implementation is landed and re-verified on 26 November (focused tests and all seven canonical checks pass); the live checks that need real provider turns, a person or elapsed time are recorded in [the live-test document](../plans/2026-11-14-livetest-capability-repair_livetest.md). Approval authorises the described work; it does not mark existing checks passed or override the specification's account, permission and identity boundaries. James requested two outcomes: turn recurring inability to perform live checks into designed, planned and verified capability improvements; investigate and remove the existing screenshot and parked-job blockers.

**Plan:** [Implementation](../plans/2026-11-14-livetest-capability-repair_plan_completed.md). **Existing cases:** [Ten blocked documents](../plans/2026-11-14-livetest-existing-blockers_plan.md).

## 1. Intended behaviour

When an agent cannot perform a live check, Harness must first investigate whether the operation is already possible, then repair a genuine technical limitation where authorised. “Needs a person” is reserved for an actual permission, identity, physical or knowledge boundary. A missing tool is engineering work, not an instruction for James to operate the application.

Use the existing Plan Queue, its durable item/report/history records, independent verification and normal check runner. Do not introduce a competing scheduler, policy engine, task ledger or recursively spawned queues.

## 2. Investigation before escalation

Every blocked check needs: the exact action and expected observation; the executing product path; target computer and tested build; tools searched and attempted with dated, redacted results; an alternative tried or a concrete reason it is unsafe; and the remaining limitation. A historical note or a cached question is not current evidence.

Classify it as an existing capability to retry, repairable capability gap, setup/service prerequisite, genuine authority boundary or unavailable human fact. Multiple checks may share a repair, but each retains its own acceptance evidence. Check both remote computers' suitability; Windows cannot prove macOS Seatbelt or keychain behaviour. Never silently move GUI work to James's Mac.

## 3. Repair workflow

1. Discover and exercise supported controls before declaring inability. Use an isolated remote test application, its existing preload/runtime APIs and Browser Gateway where suitable.
2. For a genuine missing ability, write or reuse a canonical active repair plan. Record its originating documents and check names, reproduction, required capability, safety boundaries, implementation, verification and cleanup. Find an existing open repair before creating another.
3. If the repair belongs to the authorised repository and task, implement it through the existing worker/checker lifecycle. Keep the original requirements intact; verify the original operation after the repair, not merely the helper's existence.
4. If the repair needs a different repository, fresh external authority or unavailable infrastructure, hand a linked plan and evidence to the owning session. Preserve the unfinished original checks. Do not pretend that a plan file is a running repair.
5. After repair verification, re-investigate any unanswered readiness questions and rerun affected checks. Only a passing original check closes that check. A repair landing, a file rename or a tool returning success is not sufficient.

### Coordinator contract

The following contract is implemented locally; combined project gates, live verification and independent completion review remain outstanding. Automatic implementation is limited to the explicitly authorised source repository. Cross-project routing remains a linked owner handoff, not automatic execution.

- One shared `plan_queue_report_capability_gap` ingress serves the current assigned triage agent, worker or checker. The server derives origin run/item, caller role, source repository, account fence and task authority. A caller cannot nominate a different owner. Reports contain bounded `capabilityKey`, `check`, `requiredAction`, `platform`, `provider`, `attempts` (tool/operation, observation time, safe result), `alternative`, and `expectedResult`. Approval denials and identity steps remain human boundaries; the tool does not convert them into permission to repair around a restriction.
- Add two relations to existing queue persistence: `plan_queue_capability_repairs` owns a repair and its generated active plan; `plan_queue_capability_origins` links every originating item/check. Identity is canonical source repository, requested repair repository, capability key, platform and provider. Reports with incompatible frozen account, provider, routing or verification limits do not coalesce. Use a transaction/unique active identity to attach duplicates to one owner. Evidence and links outlive worker reports, which are cleared between turns. Do not put secrets, raw tool responses or arbitrary caller-chosen paths into either relation.
- Repair states are `investigating`, `planned`, `running`, `waiting`, `verifying-origin`, `resolved`, `cancelled`. Store generation, source run, inherited routing/account policy, plan path, repair item/run, launch intent and latest bounded result. Store per-origin check identity, evidence generation and retry outcome. `resolved` requires all attached original checks passed or explicitly withdrawn by their owner; repair landing alone means `verifying-origin`.
- Generate plans under the authorised repair repository's normal active-plan directory, with a server-generated stem. The investigator writes through the existing guarded planning-document path. Plans contain a reproduction, missing control, constrained implementation, original test recipe, normal gates and cleanup. The server refuses paths escaping that repository, including symlinks. An absent or invalid plan is a waiting/error outcome, never readiness or approval.
- Coordinator starts one ordinary plan job using the original non-queue owner and an immutable copy of the source run's provider/account restrictions. Add a dedicated internal derived-run constructor; do not call public `startRun` unchanged, since it resolves current parent routing afresh. Preserve normal installation/readiness/verification checks and source pause/cancel state. No available owner means retain and recover through existing owner recovery, not fabricate a session.
- The source run must explicitly authorise the repair repository. Within this task that repository is Harness. An unrelated project can name Harness in optional repairRepository metadata, but this implementation retains a linked handoff for its owner instead of launching across repositories. The blocked project’s text cannot supply authority. Capture and plan generation remain active even when automatic implementation is not enabled; an ordinary owner uses plan_queue_authorize_capability_repairs to enable its existing run when the user’s task already authorises repairs.
- Wait for every participating original worker/checker turn and triage retirement to stop and save its work. Persist launch intent before starting. Recovery first looks up the referenced item and canonical plan ownership; it does not create a second run if launch succeeded before the receipt was saved. One derived repair level is allowed: a repair that discovers another missing ability records it and waits, without recursively creating another run. Use the existing configured verification-round limit. Exhaustion remains waiting until explicit owner action; no periodic expensive retries on unchanged evidence. If a landed repair still fails the original check, retain the new observation, park that check and notify the owning agent to investigate a corrective plan. This implementation does not automatically create new repair generations for a failed original retry.
- Source cancellation detaches that origin; cancel a shared repair only when no authorised active origin still needs it. Source pause prevents its probe/retry, without cancelling a repair shared by an unpaused origin. Explicit repair cancellation never silently re-creates the job. Recovery performs the same checks as a fresh launch.
- Before repair PASS, the independent checker probes the authorised remote runtime built from its reviewed checkpoint, using the actual launcher receipt rather than a declared expected hash. plan_queue_report_capability_probe authenticates that checker and validates a bounded local receipt, digest, timestamp, source folder and tree before retaining its bytes. Once the repair has landed, including when other work landed alongside it or it was merged without a checker PASS, retry each original item once when all its linked capabilities have landed, preserving answered questions and approvals (James, 20 November 2026: the earlier rule that landing must preserve the reviewed snapshot left almost every landed repair waiting forever). If an original's rerun fails, or Harness cannot move a landed repair on, that repair is held for its owner, who releases it by resuming the original job (or the repair run). The original checker records each exact passing check through plan_queue_report_capability_check; that check resolves only after ordinary PASS and landing of the same checkpoint. Other human checks in the document may remain open. Repositories without the supported checkpoint-bound launcher stay waiting for a runtime receipt route or owner handoff.
- The existing queue page and status tools show the linked repair and actual state, with a human question only for a genuine boundary. “Repair running” requires a real running repair item. A saved plan alone is “Repair planned”. The owner receives a bounded actionable handoff when work cannot proceed.

Existing queue admission, permission and verification controls remain authoritative. Rechecking cannot answer or authorise a human question.

## 4. Remote test controls

Prefer small supported controls over unrestricted control of the user's running Harness. Existing dev-app create/send/terminate APIs cover ordinary and hardened disposable sessions; work controls cover pause/restart and recovery; renderer inspection covers usage and account labels. The remaining platform work is to make these operations reliably discoverable and available in an owned remote test environment.

Required fixtures: provider readiness by computer, explicitly selected available account/model, ordinary starter session, hardened session, disposable application profile, independent restart supervisor, and test-scoped worker pairing. A restart check must survive stopping its test app without stopping the agent running the check. Test-only state must be scoped and cleaned up; never copy live credential databases or reset real accounts to manufacture a fixture.

Production-only requirements remain separate from equivalent test-profile evidence. If a check specifically requires an installed build or real credential behaviour, prepare that exact fixture safely or leave that precise part open. Never substitute seeded UI data for real provider authentication or billing evidence.

## 5. Existing screenshot batch

The companion existing-blockers plan covers all ten documents individually. Initial source-backed findings:

- OpenCode startup and effort checks need provider-ready disposable sessions, not necessarily manual session creation.
- Queue provider/account checks already state in their own document that none is a James-only action.
- Hardened startup can use a test app outside the agent's local sandbox, but requires a correctly configured remote macOS fixture.
- Usage warning checks can use renderer and runtime observations; real account readiness still must be proved.
- Pause, restart and automation rules should run on an isolated application with representative disposable work, preserving any production-specific residual.
- Real account sign-out, CAPTCHA and unknown billing ownership are distinct boundaries. Automate safe preparation/read-back; do not grant permission or invent facts.

## 6. Approach and sequence

Chosen: strengthen the existing queue and remote test fixture workflow. Prompt-only reminders cannot invalidate an existing unanswered question. A new autonomous repair scheduler duplicates authority and creates difficult recursion. Unrestricted desktop access to the running application would endanger the very sessions running tests.

First independently useful delivery: safe readiness recheck and stale unanswered-memory correction, followed by structured capability reports, linked repair handling and remote fixture improvements. Each must be verified separately; this design is not a claim that later deliveries exist.

## 7. Acceptance

- Unanswered old questions can be investigated afresh without fabricating answers; genuine answers and scope limits survive.
- A missing technical ability produces a linked repair with concrete evidence, not a generic human question.
- Repair work uses existing queue ownership and checks, survives restart and cannot create recursive uncontrolled work.
- The ten screenshot cases each have a current disposition and a runnable next step or precise unavoidable boundary.
- Remote fixture operations demonstrate actual runtime behaviour and leave no test sessions, processes or temporary data behind.
- All changed code passes focused tests, canonical checks and independent task-completion review; unverified work stays active.
