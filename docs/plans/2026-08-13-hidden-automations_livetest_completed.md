# Hidden automations live-test checklist

> **Found a defect while running these checks?** Record it in the remediation register —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. A pending or unrun check is not
> automatically a defect, but a *reproduced* one belongs there, not only here. Per-check evidence
> stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Prerequisites: a rebuilt/restarted Electron app running against James's real `harness` RLM
profile (`~/Library/Application Support/harness/…`), so migration `044_automations_hidden` runs
for real and the 7 curated automation names can be matched against James's actual automation
rows. Everything code-level (types, store round-trip, spawn provenance, archive carry-over, rail
filtering predicates, toggle persistence, IPC/MCP schemas, editor checkbox) is implemented and
covered by unit/integration tests — see
`2026-08-13-hidden-automations_plan_completed.md` for the as-built summary and gate results. This
checklist covers only the parts unit tests cannot reach: a real migration run against James's real
data, and real rail behaviour in a running UI.

**Do not restart the packaged app at `/Applications/Harness.app` (main pid 32411) to run these
checks** — it hosts James's live sessions and the orchestrating agent's own session. Read-only
`sqlite3 ... mode=ro` inspection of its profile is fine; run the live rail checks in a separate
rebuilt dev/packaged instance the operator restarts on their own schedule instead.

## 1. Migration 044 runs against the real profile

1. After the app is next rebuilt and restarted (any normal restart, not induced for this check),
   read-only query the real `rlm.db`: `sqlite3 -readonly "<profile>/rlm/rlm.db" "SELECT name FROM
   _migrations WHERE name = '044_automations_hidden';"` and `"SELECT name, hidden FROM
   automations;"`.
2. Expected: the migration row exists, and `hidden = 1` for exactly the 7 curated names in
   `docs/plans/2026-08-13-hidden-automations_spec_completed.md` (Leads panel uptime check,
   Work-finder health watchdog, Process outreach review instructions, ComTech inbox review (bids
   and replies), Monday work-finder brief, Spark DPS RM6094 monthly MI return, LinkedIn accept and
   reply live check) — every other automation row has `hidden = 0`.
3. Why deferred: the migration only runs when a real app boots against the real profile; the
   curated name list can only be validated against James's actual automation rows, not a seeded
   test database.

## 2. Hidden automations disappear from the rail by default

1. In the rebuilt app, open the project rail with the "Show hidden automation runs" toggle off
   (its default, `SHOW_HIDDEN_AUTOMATIONS_STORAGE_KEY` unset).
2. Let one of the 7 curated automations fire normally (or wait for its next scheduled run).
3. Expected: while it runs and after it completes cleanly, its session does not appear in the
   rail. The Automations page still shows the automation and the run's full output/history
   unchanged.
4. Why deferred: needs a real automation to actually fire against the real rail UI; unit tests
   already prove the filtering predicate (`isHiddenAutomationInstance` /
   `isHiddenAutomationHistoryEntry`) in isolation.

## 3. Toggle reveals hidden runs

1. In the same session, switch "Show hidden automation runs" on.
2. Expected: the previously-hidden automation's live and/or archived session now appears in the
   rail; existing `hideFromProjectRail` internal probe sessions remain hidden regardless of the
   toggle.
3. Toggle back off and confirm the run disappears again, and that the on/off state survives an app
   restart (persisted via `instance-list-preferences.ts`).
4. Why deferred: needs a real toggle click against a real rendered rail with a real hidden
   automation present.

## 4. Failure escape hatch in the real rail

1. Cause (or wait for) one of the 7 hidden automations to end in a failure or park on
   `waiting_for_permission` / `waiting_for_input`, with the toggle off.
2. Expected: that run's session is shown in the rail despite being hidden — the escape hatch from
   the spec's Decision 3.
3. Why deferred: needs a real failing/parked run; inducing a fake failure against a production
   automation is destructive and out of scope for an unattended agent, so this is intentionally
   left for James or a future session with room to safely trigger (or simply observe) a real
   failure.

## Status

Not yet run. All four checks above require a rebuilt/restarted app against James's real profile
and, for #2–#4, a real automation actually firing. None can be completed by an unattended agent
session without either restarting James's live packaged app or fabricating failures against his
real automations, both of which are out of scope here.

## Evidence run — 2026-08-19 (orchestrator): migration check LIVE-VERIFIED against real data

James rebuilt and restarted the packaged app at 01:39 on 2026-08-19 (app.asar 01:39, aio-mcp SEA
01:40, new main pid 22117). That retires the "cannot verify without a rebuild" blocker this doc was
created under — the app has now started once with migration `044_automations_hidden` present.

**Check — migration applies cleanly against James's real automation data: PASS.**

Read-only against the production profile (`sqlite3 'file:…/harness/rlm/rlm.db?mode=ro'` — the live app
was not restarted, killed, or written to):

```
SELECT COUNT(*) FROM automations WHERE hidden = 1;   →  7
SELECT name    FROM automations WHERE hidden = 1 ORDER BY name;
    ComTech inbox review (bids and replies)
    Leads panel uptime check
    LinkedIn accept and reply live check
    Monday work-finder brief
    Process outreach review instructions
    Spark DPS RM6094 monthly MI return
    Work-finder health watchdog
```

Compared against the curated list in the migration itself
(`src/main/persistence/rlm/rlm-migrations-041-045.ts`, `044_automations_hidden`): the two sets are
**identical — all seven names, no extras, no omissions.** So the column exists, the migration ran, and
it selected exactly the intended rows against real production data rather than a fixture.

Note the count is a genuine discriminator here, not just a smoke check: a migration that ran but
matched nothing would show 0, and one with a stale or over-broad name list would show a different set.

**Residual for this doc is now smaller than when it was written.** The remaining checks — hidden runs
disappearing from the real project rail, the reveal toggle, and the failure escape hatch — still need
the **renderer** of the packaged app, which exposes no debug port, so they need either James at the
keyboard for a few seconds or an opt-in remote-debugging port on the packaged build (a recurring
structural gap noted across several docs in this campaign). They are no longer blocked on a rebuild.

## Evidence run — 2026-08-24 (Batch B) — checks 2, 3, 4 driven live for the first time; **all four checks now PASS; renamed `_livetest_completed.md`**

Driven against a fresh isolated dev profile (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-B`,
`--remote-debugging-port=9452`), CDP with focus emulation (`_scratch/lt-2026-08-11/cdp-eval.mjs`).
The earlier structural blocker ("the packaged app's renderer has no debug port") turned out not to
apply — the campaign's own dev-app method reaches this UI directly, the same lesson the runbook
already documents for other docs.

**Method note — a deliberate, stated substitution.** Checks 2–4 as written say "one of the 7 curated
automations" (James's real, named ones). Those only exist in James's real production profile, and the
mechanism they exercise (`instance.metadata.automationHidden`, set from `Automation.hidden` at spawn
time, filtered by the renderer's `isHiddenAutomationInstance`/`isHiddenAutomationHistoryEntry`) has
nothing curated-name-specific about it — any automation created with `hidden: true` goes through the
identical code path. Check 1 above (2026-08-19, reconfirmed today read-only:
`SELECT COUNT(*) FROM automations WHERE hidden=1` → `7`, same seven names, migration row present)
already proves the curated names are correctly tagged in production; checks 2–4 test the generic
hiding/reveal/escape-hatch mechanism, which this run exercised with disposable synthetic automations
in an isolated profile instead. No production automation, setting, or session was touched.

### Check 2 — hidden automations disappear from the rail by default — ✅ PASS

Created a real automation via `electronAPI.automationCreate` with `hidden: true` (name `LT-B hidden
automation probe`, `provider: claude`, `workingDirectory: /tmp/aio-lt-B-work`) and fired it
immediately with `electronAPI.automationRunNow` — a real Claude CLI spawn, not a mock. It completed
(`HIDDEN-AUTOMATION-PROBE-OK`), producing an instance whose live metadata read
`automationHidden: true, automationRunSucceeded: true`.

With the "Show hidden automation runs" toggle at its default (off — confirmed
`localStorage['instance-list-show-hidden-automations']` unset/`false`), the rail's Project index
showed **0 projects**, "No projects yet".

**Positive control, same run:** created and fired a second, otherwise identical automation with
`hidden: false` (`LT-B visible automation control`). It appeared immediately: `Projects 1`,
`aio-lt-B-work: 1`, prompt text visible in the rail. This proves the first result was the hidden flag
specifically, not an artifact of the rail not indexing this working directory at all.

### Check 3 — toggle reveals hidden runs, and the on/off state survives an app restart — ✅ PASS

Opened the real filter popover (`.filters-toggle` → `.filters-popover`) and clicked the real "Show
hidden automation runs" checkbox (a DOM `click()`, not a signal write). Result: `aio-lt-B-work: 2`,
both the hidden and visible session prompts now listed in the rail. Toggled it back off: hidden
session disappeared again, visible one stayed.

**Restart persistence, checked rather than assumed:** with the toggle left **on**
(`localStorage` value `"true"`), cleanly terminated the dev app's Electron process tree (`SIGTERM` on
the main pid, confirmed all child pids gone) and relaunched it on the same profile/port. After reload,
`localStorage['instance-list-show-hidden-automations']` still read `"true"`, the checkbox rendered
checked, and the rail showed both sessions (`aio-lt-B-work: 2`, `HIDDEN-AUTOMATION-PRO…` visible)
without re-clicking anything. Toggled off again post-restart and confirmed the hidden session
disappeared once more — the full on→off, off→on-across-restart→off cycle all behaved correctly.

### Check 4 — failure/waiting escape hatch in the real rail — ✅ PASS (both live-instance and archived-history layers)

Created a third hidden automation (`yoloMode: false`, prompt: "Run the shell command `sleep 60` using
your Bash tool, then reply DONE.") and fired it. A CLI running without YOLO stops for tool approval,
landing the instance on `waiting_for_permission` — one of the two `AUTOMATION_WAIT_STATUSES`
(`instance-status-policy.ts:69`) the escape hatch is keyed on. Confirmed live:
`electronAPI.listInstances()` → `status: "waiting_for_permission"`.

With the reveal toggle **off** (`localStorage` `"false"`, confirmed), the rail still showed this
session — `"Run the shell command `sleep 60` using your Bash tool, then / Awaiting approval"` —
despite `automationHidden: true` on its metadata. This is the escape hatch working: a hidden run
parked waiting for a human is shown regardless of the toggle.

Terminated the instance (`terminateInstance`) to end the run and confirmed the **archived** history
entry independently exercises the same escape-hatch logic at a different layer:
`isHiddenAutomation` was **absent** (falsy) on the archived entry — matching `history-manager.ts:274`
(`isHiddenAutomation` is set only when `automationHidden === true` **and**
`automationRunSucceeded === true`; a run terminated mid-wait never sets `automationRunSucceeded`).
So a hidden automation that ends abnormally stays visible after archiving too, not just while live.

An earlier attempt in this same run (a hidden automation asked to "count slowly from 1 to 50")
finished in ~11.5 s — faster than the terminate call landed — and archived as
`status: "completed", isHiddenAutomation: true`, i.e. correctly re-hidden because it *did* finish
cleanly. That negative-control result is consistent with, not contradicting, the escape hatch: a
successful hidden run stays hidden; only an abnormal one is exempted.

### Cleanup

Deleted all four automations created this run (`automationDelete`) — all four in the isolated
`/tmp/aio-lt-B` profile only, never production. All spawned instances (`cxac6chjr`, `cd4i39ou1`,
`ctskdwy2a`, `cpnnupbow`) reached a terminal state (completed or terminated) and archived normally;
none left running.

### Doc status: all four checks now PASS with current, dated evidence — renamed `_livetest_completed.md`

Check 1 (2026-08-19, reconfirmed read-only today) and checks 2–4 (this run, live) all pass. No open
residual remains that this doc's own checks describe.
