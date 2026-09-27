# Sibling-Audit Round 2 — Live-Test Checklist

## Status — completed 2026-09-27

Open: 0 · Passed / closed here: 18 · Transferred residual campaigns: 5 · Failed: 0

The two remaining rebuilt-app checks passed on 2026-09-27. The five distinct checks that
genuinely require a product decision, consequential production authority, a live external service
or a physical mobile client now live in the consolidated human/external residual checklist. This
source checklist is closed; do not run its historical failed procedures again from here.

> **Remediation flow:** a **reproduced** defect from this doc goes into
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus
> observed behaviour, root cause, required behaviour, acceptance), with a matching
> implementation-status section in
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence stays in
> this doc. Before running a campaign, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** `docs/plans/2026-07-30-sibling-audit-round2_plan_completed.md`

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| A1 — queue survives renderer crash + attachments | 2026-08-18 (Batch S2) | `app.log` `render-process-gone{reason:'crashed'}`; queue/attachment/notDurable-toast all restored, no defects |
| A2 — tool-loop warning toast, both halves | 2026-08-12 root-cause (LT-061, LT-062 fixed) → 2026-08-18 (Batch S) clean pass | `app.log` warn@3/critical@6, one auto-interrupt log line; residual: Codex/Gemini lack correlation ids so only reach `runaway` counting, not filed as a blocking gap |
| A3 — demoted review findings visible | 2026-08-18 (Batch S3) | real `classifyFreshEyesBlocking()` + `LoopStore.activityForLoop()` DOM render, both anchor-badge and demoted-with-reason cases confirmed |
| A4 — approve / edit-approve / reject + persistence + prior-context (WS-A4 half) | 2026-08-18 (Batch S2) | `LessonStore.all()` provenance check, survives app restart, lesson text appears in next loop's `planStageContext` |
| A5 — admission suppression, non-Discord half | 2026-08-18 (Batch S) | `app.log` `SessionAdmissionService "Automated write suppressed" reason: "awaiting-human"` + redelivery-on-ready-edge confirmed; incidental unrelated race found and filed as LT-137 (not fixed, not part of this check's scope) |
| B1 — PR creation, Gate 1 (opt-in UI + refusal wiring) | 2026-08-24 (Batch E), re-confirmed unchanged 2026-08-25 | LT-138 fixed; `source-control-repo-actions.component.spec.ts` 6/6; live `vcsCreatePullRequest` refusal message matches new UI wording |
| B6 — Progressive Council | 2026-08-18 (Batch S2) | LT-197 fixed; live DOM shows real `Running…` state; cancel/nav-away-and-back/reload/3-synthesis-methods all confirmed |
| B7 — compaction preview dialog | 2026-08-18 (Batch S) | LT-136 fixed; checkpoint timeline shows correct label post-fix, Codex app-server honesty note confirmed |
| C1 — decision timeline, all 5 scenario types | 2026-08-18 (Batch S3) | `workboardGetDecisionsForItem` + Workboard DOM for admission/compaction/automation-retry/provider-limit-park/loop-blocker; LT-194/LT-195 fixed en route |
| C2 — same-urgency-everywhere (Workboard ↔ session picker) | 2026-08-24 (Batch E) | live DOM comparison, same `attentionLevelForInstanceStatus` classifier confirmed on both surfaces |
| C3 — readiness banner | 2026-08-18 (Batch S) | injected `StartupCapabilityReport` at the real seam; banner/Send-disable/Doctor-action/dismiss-warning all confirmed in DOM |
| C4 — diff annotations | 2026-08-18 (Batch S2) | real git repo; stale/fresh re-anchoring, "Send anyway" packet with state markers, agent addressed comments, "Fix selected" all confirmed |
| C5/C7 — authority cards + contained runs | 2026-08-18 (Batch S) | LT-139 fixed; fire-time enforcement message, real sandbox `Operation not permitted`, no env secrets in child `ps eww` |
| C6 — context manifest panel | 2026-08-18 (Batch S) | epoch 0 (2026-08-12) + respawn epoch via `resumeById()` + restart-compact epoch via `compactInstance` all confirmed |
| C9 — keyboard registry live | 2026-08-18 (Batch S) | real bubbling `Escape` KeyDown on CDK overlay confirmed `stopPropagation` fix protects a busy generation; Keyboard search + reserved-binding refusal confirmed |
| C10 — virtualization flag | 2026-08-19 (Batch N4) | 16-turn real transcript; windowing (25 rows + 7 spacers), jump-rail `scrollTop` deltas, find-drops-spacers-to-0, flag-off parity, no-jump-during-streaming all confirmed |
| C2 — approve/confirm from Workboard card (LT-523 re-check) | 2026-09-27 | rebuilt isolated app, real non-YOLO Claude session and real Workboard **Approve** click: the orchestration admission was `suppressed` with `awaiting-human` while the unrelated Bash permission remained parked, then became `delivered` once after that permission resumed; one Bash call executed, both marker and idle settlement were verified, and no orphan, duplicate call or illegal transition appeared. `app.log` lines 28943–29055 and `_scratch/lt-2026-09-27/sibling-audit/` retain the runtime evidence |
| C2 — Snooze durability (LT-481 re-check) | 2026-09-27 | rebuilt isolated app and real Workboard **Snooze** click: the card remained absent at eight 2-second samples while the real instance stayed `waiting_for_permission`, then reappeared immediately under **Done / Idle** after the exact deferred permission resumed; the harmless `LT481_OK` marker and idle/no-error state were verified |

## Residuals transferred out

| Former check | Consolidated owner | Reason |
| --- | --- | --- |
| A4 — Scan for corrections / LT-196 | [RES-015](2026-09-27-livetest-human-external-residuals_livetest.md#res-015--choose-the-lt-196-correction-mining-contract) | the reproduced defect has two materially different product fixes and needs one explicit contract choice |
| A5 + B8/C8 — Discord admission and progress behavior | [RES-008](2026-09-27-livetest-human-external-residuals_livetest.md#res-008--discord-bot-mobile-parity-campaign) | all remaining assertions require an inbound action from James's allow-listed Discord identity; the WhatsApp negative assertion needs a live configured channel |
| B1 Gate 2 — native push + PR approval | [RES-016](2026-09-27-livetest-human-external-residuals_livetest.md#res-016--real-push-and-pull-request-native-approval-round-trip) | approving creates an external branch/PR and the native dialog requires explicit consequential-action authority |
| B3 — Guardian adjudication | [RES-017](2026-09-27-livetest-human-external-residuals_livetest.md#res-017--guardian-adjudication-with-a-reachable-auxiliary-llm) | no local Ollama binary or service is available as of 2026-09-27 and no authorised reachable auxiliary endpoint is available to the isolated app |
| C2 — physical-mobile badge parity | [RES-013](2026-09-27-livetest-human-external-residuals_livetest.md#res-013--physical-iphone-mobile-queue-interrupt-and-rendering-campaign) | requires a paired current physical client and genuine device-token handshake |

## Notes

- **LT-137** (interrupting an instance while a just-approved deferred-permission auto-resume
  is in flight can drop the approved action) was found incidentally while running A5's
  non-Discord half. It is not one of this doc's listed checks and A5 itself is closed; the
  defect is tracked only in the remediation register, not fixed.
- **Ordinary local Mac UI control is no longer a blanket blocker** (standing authorization
  granted 2026-08-26). It enabled the rebuilt-app C2 checks above, but does not authorise a
  real push/PR, supply an external model server or replace a physical mobile client.
