# Plan Queue ranked provider lists

Status: implemented and verified 2026-10-26, including the fresh-eyes follow-up fixes; live checks deferred to
[the livetest doc](2026-10-25-plan-queue-ranked-routing_livetest.md).

Requested by James: "funnel new sessions into certain providers and models where possible so that
I can use up the correct model and provider and account". One list for everything (not per
project folder), confirmed by James on 2026-10-25.

## Why the queue looks random today

- The saved Plan Queue choice (`planQueueRouting`) is empty, so workers copy the session that
  starts each run. The last 15 runs went Claude 9, Codex gpt-6.1-sol on the comtech account 4,
  OpenCode MiMo 2 (`plan_queue_runs.config_json`, read 2026-10-25).
- Checkers are automatic (Codex, then Claude, never the workers' provider), and in 5 of those runs
  the starting session passed its own checker list, which beats the saved choice.
- Workers take one provider/model/account choice. Accounts inside one provider already follow
  priority then soonest reset, but nothing moves new sessions to another provider when one runs
  out; queue sessions use `failoverProviders: []` and wait.

## What changes

1. `PlanQueueRouting.worker` (one choice or null) becomes `workers`, a ranked list (max 10).
   Empty = the session that starts the run. Persisted values are migrated:
   - saved setting: a settings migration rewrites `{ worker }` to `{ workers }`;
   - stored runs: `plan-queue-store.ts` reads a legacy `config.routing.worker` as `workers`.
2. Each new worker session (and first triage) starts on the highest line with usage left
   (`plan-queue-route-usage.ts`). Usage evidence: for account pools, the pool's own selection
   (`ProviderAccountRoutingService.preview`, fenced to the line's accounts) — a line is usable when
   the pool finds an account without a parked/exhausted/credits-only veto; otherwise the limit
   ledger (`ProviderLimitLedger.getActive`) for the line's provider and model. With no line usable,
   the line whose known limit lifts soonest is used (unknown = never; ties keep list order), so the
   session waits there as it does today. Lines on the never-auto-pick list are skipped unless the
   run relaxes it. A one-line list is never checked (nothing to move to).
3. A live session never moves. Respawns (resume after restart, resume of a parked item, worker
   send failure, Pause then Resume) are new sessions and pick again.
4. Each item records the provider and model its worker actually ran on when a work round ends
   (`plan_queue_items.worker_provider/worker_model`, loop migration 024) so the checker is chosen
   against the real worker even after that session is gone (restart, pause). Recorded at round end,
   not spawn, because a session's provider reads "auto" until its startup resolves it; the checker
   takes provider and model from one source, never mixing a recorded provider with another model.
5. Checker lists skip lines with no usage left the same way (first usable eligible line, else the
   eligible line whose limit lifts soonest). Automatic checker selection is unchanged.
6. Start precedence: James's saved list wins per role. An agent's `plan_queue_start` `workers` /
   `verifiers` apply only where the saved choice for that role is empty (Workers: same as the
   session; Checkers: automatic); when set aside, the tool result says so. A parent's
   `set-routing` on a running run stays as today (explicit, notified, "only when James asked").
7. Start validation: every worker line is checked like today's single worker; every worker line
   must have at least one checker that can differ from it.
8. Triage retry diversity uses the first triage's actual provider and model (not the run's first
   line), so the routing-change key drops `run.workerModel`.
9. Plan Queue page: Workers gets "Same as the session that starts the run" or "Only these, in this
   order" with the same add / up / down / remove rows as checkers. Copy explains the order rule.
   Run list summary shows the ranked workers. The saved choice moves above the runs as one summary
   line with Change (James could not find it on 2026-10-25: it sat below the whole run history).
10. MCP tools and docs: `plan_queue_start.workers` (ranked array) replaces `worker`;
    `set-routing.routing.workers` replaces `worker`; descriptions state the saved-list precedence.
    Update `docs/AIO_MCP_CLI.md` and `docs/architecture.md`.

## Out of scope

- Per-project lists (James chose one list).
- Moving a live session mid-document, or auto-resuming an item parked on a provider limit.
- Usage-aware automatic checker selection.

## Known limit

- A respawn picks a worker choice like any new session, so a document whose first worker's choice
  ran out can continue on another provider (as an explicit `set-routing` move already could). The
  checker is then chosen against the latest worker only, so it may share a provider with an
  earlier worker on that document. Rare in practice: a worker that hits its limit parks the
  document until James resumes it.
- A checker without a named model is checked under the model a new session would start on; if
  checker selection then re-models it for family diversity, a limit recorded only for that other
  model can be missed. The session then starts and waits for the reset, as before this work.
- With every choice out, the fallback picks the soonest reset the limit ledger knows; reset times
  known only from usage snapshots are not compared.
- Closing the saved-choice editor (or a run's) drops unsaved edits, as the run editor always has.

## Verification

- Unit tests: route usage (pooled usable / parked fallback / legacy ledger / non-pooled ledger /
  soonest reset / exclusions), routing resolution (precedence, set-aside, per-line checker
  check, legacy shape), spawn line choice incl. routing change during selection, verifier list
  skipping, item worker record and checker fallback, triage retry model, store legacy read and
  migration 024, settings migration, panel list editing and validation, run list summary.
- Gates: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
  `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer`, `npm run test:quiet`.
- Fresh-eyes gate with `task-completion-gate`.

## Progress

- [x] 1 schema + migrations (contracts, settings migration, store read upgrade, loop migration 024)
- [x] 2 route usage (`plan-queue-route-usage.ts`, spawn choice in `plan-queue-spawn.ts`)
- [x] 3 respawn behaviour (new sessions pick again; see Known limit)
- [x] 4 item worker record
- [x] 5 checker lists
- [x] 6 start precedence (`routingSetAside` in the start result)
- [x] 7 start validation (every choice checked; every worker choice needs a usable checker)
- [x] 8 triage retry
- [x] 9 Plan Queue page (worker list editor; saved choice above the runs as one line with Change)
- [x] 10 MCP tools and docs

## As built

- Gates on 2026-10-25: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`,
  `npm run build:renderer` all exit 0; full `npm run test:quiet` passed. The renderer build's
  initial-bundle budget warning predates this work (the Plan Queue page is a lazy chunk).
- Fresh-eyes gate round 1: PASS with two Low findings (provider recorded as "auto" at spawn;
  recorded provider paired with another choice's model) and doc close-out items, all fixed.
- Fresh-eyes gate round 2: PASS with four Low findings. Fixed: the worker route is read before the
  checkpoint can yield; `plan_queue_start` arguments are strict, so a stale `worker` argument is
  refused; the page's Change button names what it changes. Recorded as a known limit: the usage
  check's model (above).
- Fresh-eyes gate round 3: PASS with no actionable findings (full suite 2791 files, 35313 tests).
  Optional follow-ups it noted: the first triage records a provider without the "auto" guard
  (unchanged from before this work), the summary line shows raw account ids like the run cards,
  and closing the saved-choice editor drops unsaved edits.
- Fresh-eyes flow tracing (James, 2026-10-25): three reviewers traced start-from-chat, the page and
  IPC, and James's real settings and run history (copies). His saved value, all 200 stored runs and
  migration 024 upgrade cleanly. Fixed:
  - importing a settings export from before this change was refused outright (now upgraded);
  - the usage check used `defaultModelByProvider` only; it now resolves the model with the spawn's
    own `ModelSelectionResolver` (his Grok resolves to grok-4.7, which has a recorded limit);
  - a limit the provider has since lifted (reset credit, top-up) still counted on providers without
    an account pool and pre-pools sign-ins; it now honours the same lift evidence as the send path,
    never purchased credits alone;
  - a run could start with a choice whose CLI is not installed, and the spawn silently fell back to
    another provider; starting a run now refuses that, like changing a run's route already did;
  - a failed checker lookup left the item "verifying" with no checker; it now parks with the reason;
  - an old-shape saved value (written by an older build sharing the settings file) crashed run start
    and the page; every read now upgrades it (helper moved to `src/shared/utils`);
  - an open editor rebuilt every row on any unrelated update, closing open lists and losing focus;
  - a run saved as "same as the session" never showed as saved; the editor now takes the run's
    stored value after a save;
  - "Move documents in progress now?" stayed ticked after a save, so a later save restarted them again;
  - summaries showed internal account ids such as "legacy"; they now show account names;
  - each row's controls are named as a group ("Worker choice 2") for screen readers;
  - the help text and one page note described the old layout or overpromised.
- Fresh-eyes gate round 4 (on those fixes): PASS, no actionable findings. Its one worthwhile note was
  applied: like the send path, usage figures never lift a Copilot rate limit. A narrow fresh review
  of that change also passed. Final gates 2026-10-26: tsc, typecheck:spec, lint, check:ts-max-loc,
  check:ui-hints, build:main, build:renderer exit 0; full suite 2791 files, 35338 tests passed.
- Live checks that need the rebuilt and restarted app are in
  [the livetest doc](2026-10-25-plan-queue-ranked-routing_livetest.md).
