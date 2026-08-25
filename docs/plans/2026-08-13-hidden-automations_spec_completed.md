# Hidden Automations — Spec

Status: COMPLETED — implemented, tested, and gated 2026-08-19; live-test checklist deferred, see
`2026-08-13-hidden-automations_livetest.md`.
Implementation plan: [2026-08-13-hidden-automations_plan_completed.md](./2026-08-13-hidden-automations_plan_completed.md)
Date: 2026-08-13

## Problem

Every automation run spawns a real session that appears in the project rail alongside
sessions James actually started. For automations whose *output is somewhere else* —
a health check that only matters if it fails, a run whose deliverable is an email or a
board card — the rail entry is pure noise.

Observed in the rail: "Cheapest gate check", "Community Tech Health Watch…",
"Run the Community Tech Work Finder health…", "Weekday LinkedIn live check",
"Joebennett92@outlook.com account verifica…". None of these are things James opens.
They push the sessions he does care about below the fold and force "Show more".

## Current behaviour (verified by reading)

- `automation-runner.ts:267` and `:805` stamp `metadata.automationId` /
  `metadata.automationRunId` on the spawned instance. Durable provenance that
  survives AI auto-titling and archival.
- `instance-row.component.ts:88` computes `isAutomation` from that metadata; the rail
  draws a clock icon (`instance-row.component.html:106`,
  `instance-list.component.html:507`).
- **There is already an end-to-end rail-hiding mechanism**, used today for internal
  reviewer/probe sessions:
  - stamped at spawn as `instance.metadata.hideFromProjectRail`
    (`reviewer-session-spawner.ts:159`, `orchestrator-tools-step.ts:495`);
  - read at archive time by `shouldHideInstanceFromProjectRail`
    (`history-manager.ts:1105`) and written onto the history entry
    (`history-manager.ts:264`), with a `previousEntries` fallback so re-archiving a
    restored thread does not lose the flag;
  - honoured by the rail for live instances
    (`project-rail-builder.service.ts:654`) and archived entries (`:59`).
  It is **unconditional and has no un-hide path**, which is right for a probe session
  and wrong for an automation James may need to notice.
- `ConversationHistoryEntry` already carries `isAutomation?: boolean`
  (`history.types.ts:154`) and `status: ConversationEndStatus`
  (`'completed' | 'error' | 'terminated'`), so archived entries can support the
  failure escape hatch without a cross-store join.
- `AutomationDeliveryMode = 'notify' | 'silent' | 'localOnly'` (`automation.types.ts:9`)
  is per-**run** and only read in `automation-runner-helpers.ts:66` to decide whether
  to raise a notification. Orthogonal to rail visibility; not overloaded here.
- `Automation` already tracks `consecutiveFailures`, `lastFailureAt`,
  `lastFailureReason` and auto-disables on repeated failure.
- Latest RLM migration is `043_drop_file_metadata` (`rlm-migrations-041-045.ts:50`).

## Design

Add `hidden?: boolean` to `Automation` (per-automation, not per-run). When true:

1. **Rail**: sessions spawned by that automation — live and archived — are excluded
   from the project rail.
2. **Automations page**: unchanged. Run history, output and errors all still there.
   Hidden is a *rail* concept, not a *secrecy* concept.
3. **Failure escape hatch**: a run that ends in failure, or parks waiting for a human,
   is shown in the rail regardless of `hidden`. A silent health check that silently
   stops working is worse than the noise it replaces.
4. **Rail toggle**: "Show hidden automation runs", so James can pull them back without
   editing any automation.

A **new, distinct** metadata key `automationHidden` is used rather than reusing
`hideFromProjectRail`. The two have different semantics — `hideFromProjectRail` means
"internal plumbing, never show", `automationHidden` means "quiet unless it needs you"
— and conflating them would either give probe sessions an un-hide path they should not
have, or deny automations the escape hatch they must have.

## Decisions (James, 2026-08-13)

1. **New automations default to visible**; hidden is opt-in. ✅
2. **Retro-fit existing automations** — James asked for a curated pass rather than
   leaving everything visible. See "Retro-fit" below. ✅ (changed from the
   recommendation)
3. **Failed runs always appear in the rail**, even when hidden. ✅
4. **`hidden` stays separate from `deliveryMode`.** ✅
5. **Hidden changes nothing about retention.** ✅

## Retro-fit

Decided by reading the operator's real automation prompts and descriptions
(read-only against `harness/rlm/rlm.db`), not by name pattern. The signal is explicit
in the prompts: these say "tell James ONLY if it is not", "Stay completely silent when
healthy", "Silent when healthy or fully self-healed", or their deliverable is an email
or a board card.

Hidden (7):

| Automation | Why |
| --- | --- |
| Leads panel uptime check | "tell James ONLY if it is not. Stay completely silent when healthy." |
| Work-finder health watchdog | "Silent when healthy or fully self-healed"; emails at most one message/day |
| Process outreach review instructions | STEP 0 cheap gate exits in seconds on an empty queue — this is the rail's "Cheapest gate check" |
| ComTech inbox review (bids and replies) | Deliverable is one internal digest email + Work Finder board updates |
| Monday work-finder brief | "Sends exactly one multipart message to james@communitytech.co.uk" |
| Spark DPS RM6094 monthly MI return | Files on the GCA service, updates the board card, emails an internal summary |
| LinkedIn accept and reply live check | Read-only observe-and-record; deliverable is the recorded data |

Left visible, and why (these are the ones a name regex would have wrongly caught):

- **LinkedIn useful-20 guarded sender** — sends real invitations; only James may
  resume it after a safety pause.
- **LinkedIn daily selection preparation** — non-empty candidates explicitly stop for
  James's review.
- **LinkedIn person discovery harvest** — writes to the production DB and is the
  load-bearing stage that had already failed silently once.
- **Tender Radar daily run**, **Weekday research and morning outreach desk** — produce
  drafts for review.
- **Twice-monthly Silkworth and Dorrington blog posts** — publishes public content.
- **Dingley quarterly backup restore rehearsal** — a contractual commitment that must
  be evidenced.
- **Compliance and renewals check (quarterly)** — four runs a year is not noise, and
  the output is a deadline list.
- **Send signed NEURO confidentiality agreement to Robert Annis** — a reminder aimed
  at James.
- Inactive `/tmp/aio-lt-ws1` livetest fixtures — untouched.

The curation ships as data in migration `044`, keyed on exact automation name and
reversed by the `down`. It is install-specific by nature; the alternative (a regex on
names or prompts) would have hidden the guarded sender, which must never be silent.

## Scope

### Data
- `Automation.hidden?: boolean`, plus `CreateAutomationInput` / `UpdateAutomationInput`.
- `AutomationConfigSnapshot.hidden?: boolean`, so a run's visibility follows the config
  as it was when the run fired, not later edits.
- Migration `044_automations_hidden`: add `hidden INTEGER NOT NULL DEFAULT 0`, then the
  curated `UPDATE ... WHERE name IN (...)`. `down` reverses both.
- Store mapping in `automation-store-types.ts`, `automation-store-records.ts`,
  `automation-store-mappers.ts`, `automation-store.ts`.

### Provenance
- `automation-runner.ts` stamps `metadata.automationHidden` at both dispatch sites from
  the snapshot, so the rail never joins back to the automation store and archived
  entries keep working after the automation is deleted.
- `ConversationHistoryEntry.isHiddenAutomation?: boolean`, carried at archive time in
  `history-manager.ts` with the same `previousEntries` re-archival fallback the
  existing flags use.

### Renderer
- `project-rail-builder.service.ts` applies the hidden predicate to live instances and
  history entries, with the failure/waiting escape hatch, gated on a new
  `showHiddenAutomations` build input.
- `SHOW_HIDDEN_AUTOMATIONS_STORAGE_KEY` + load/save in `instance-list-preferences.ts`,
  default off; toggle in `instance-list.component`.
- Hidden checkbox in the automation editor (`automation-form-model.ts`,
  `automations-page.component`).

### IPC
- Zod schemas for the new field on create/update.
- `create_automation` / `update_automation` MCP tools expose `hidden`, so an agent can
  create a health check that is hidden from birth.

## Acceptance

- A hidden automation's live session does not appear in the rail; it appears when
  "Show hidden automation runs" is on.
- A hidden automation's *failed* run appears in the rail with the toggle off.
- A hidden automation parked on `waiting_for_permission` / `waiting_for_input` appears
  in the rail with the toggle off.
- Archived entries from hidden runs follow the same rule after restart, and after
  restore-and-re-archive.
- Internal `hideFromProjectRail` sessions remain unconditionally hidden — the new
  toggle does not reveal them.
- The Automations page shows hidden automations and their run history unchanged.
- The 7 curated automations are hidden after migration; every other automation is
  unaffected.
- Canonical verification checklist green.
