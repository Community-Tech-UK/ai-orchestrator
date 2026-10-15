# Phase 0 confirmed fixes: deferred live checks

Status: pending live validation. Code and in-loop verification are recorded in the [implementation plan](2026-10-10-oct-phase0-confirmed-fixes_plan.md). The queue coordinator owns independent verification and completion renaming.

Prerequisites: build both main and renderer from the queue changes, integrate through AIO, and restart the intended Harness instance. Never run these against an old packaged build. Use isolated disposable sessions for provider experiments. Checks concerning James's historical database require that real profile; inspect backups read-only first. Restore any setting changed by the campaign.

All interactive browser or desktop work must start with Browser Gateway worker/channel health and explicitly target `windows-pc`. Local Mac browser/desktop use requires James's permission for this task. Ordinary headless CLI probes and automated headless project tests are permitted. No UI campaign was attempted during queue implementation; it is not reported as unavailable.

Remediation flow: read [livetest-campaign-runbook.md](livetest-campaign-runbook.md) before running this campaign. A reproduced defect belongs in [livetest-remediation-register.md](livetest-remediation-register.md), with a matching implementation-status section in the owning remediation plan. Keep dated per-check evidence here. The 8 October Windows routing rule and the canonical `npm run typecheck:spec` command override stale Mac-fallback and bare-spec-tsc text in that runbook.

Each check below remains open. The recorded expected behavior is not a claim that it has been observed.

## LT-P0-01: Step 1. B4: Honest end states for loops (S-M)

- [ ] Run the following steps and retain observable evidence.

**Live check (rebuilt app):**
- Force a step timeout: set `iterationTimeoutMs` to 1-2 minutes and use a prompt that sleeps silently, in an
  isolated Git workspace.
  - The timeout extends while the child streams output, up to twice `iterationTimeoutMs`
    (`loop-child-invoker.ts:88`, `:141-164`), then 30 seconds of grace. Allow for that.
- Check the status, the branch (kept, not in `integration/main`), the desktop notice and the Workboard row.
- Optional: run the same from an automation and check that the run shows failed.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-02: 2.1 "/goal" cannot start (S)

- [ ] Run the following steps and retain observable evidence.

**Live check:**
- `/goal <small task>` starts a loop, pauses at its completion claim, and Accept finishes it.
- A forced refusal shows its reason in the transcript.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-03: 2.4 Checkpoints keep only the last round (S)

- [ ] Run the following steps and retain observable evidence.

**Live check:** restart the rebuilt app in the middle of a run, then confirm in the database that the resumed run
starts with 5 rounds of history.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-04: Step 3. C1: "Close all" asks first; closing stops loops (S)

- [ ] Run the following steps and retain observable evidence.

**Live checks:**
- With a same-session loop running, Close all stops the loop, and no new provider process appears.
- A quota-parked session closed with Close all is not revived when the limit resets.
- Plan queue with a worker active: the item is parked as a worker error. Record whether the queue starts a new
  worker.
- A remote-node session ends its remote process.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-05: Step 4. C3a: Permission buttons name their scope (S)

- [ ] Run the following steps and retain observable evidence.

**Live checks:**
- A real denial: "Always allow (…)" writes the rule, the session restarts, and the retry succeeds. "Don't allow"
  leaves `permissions.json` unchanged.
- A held shell call with "Allow for this session": the same command later in the session is allowed without asking.
- A held shell call refused with "Don't allow" is refused (not run), and the same command asks again next time.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-06: Step 5. D1: Tooltip directive fixes (S)

- [ ] Run the following steps and retain observable evidence.

**Live checks:**
- In the rebuilt app, hover a disabled button that has a tooltip.
- A long path wraps.
- The code style is readable in light and dark themes.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-07: Step 6. MEM-4: Notes from past sessions reach new sessions (XS-S)

- [ ] Run the following steps and retain observable evidence.

**Live check:**
- Start a session that has a first message, in a repo with stored notes, and confirm the context manifest shows a
  filled block.
- A person judges whether the notes are relevant. If they are not, A20's gating comes forward.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-08: 7d. Correct the stored history, with a backup (M)

- [ ] Run the following steps and retain observable evidence.

**Live check:** first start of the rebuilt app against James's real database. Check the backup table, the summary
line, and that the `a0-per-turn-booking-live` row exists. After a few turns, confirm the new rows are per-turn amounts
and that the backup holds none of them.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-09: 7f. Helpers back off when their model is down (M)

- [ ] Run the following steps and retain observable evidence.

**Live check:**
- Stop the helper model on the Windows PC.
- Watch for the chip, one notification, and no probing during the pause.
- Restart the model and check it recovers.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-10: 7g. A spend backstop for Harness-started Claude one-shots (S)

- [ ] Run the following steps and retain observable evidence.

**Live check:** run a magic prompt with a $0.01 cap and confirm the exit code and the result line.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-11: 7h. Costs page: spend by purpose and by provider (M; last)

- [ ] Run the following steps and retain observable evidence.

**Live check:** a visual check of the layout and wording, with real data, on the Windows PC or with James's OK.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-12: 7i. Record each Claude subagent's size, tool count and run time (S; record only)

- [ ] Run the following steps and retain observable evidence.

**Live check:** a real turn that spawns one foreground and one background subagent writes two records.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-13: Step 9. A14: Second opinions become deliberate (M, after 7a)

- [ ] Run the following steps and retain observable evidence.

**Live checks:**
- A real Claude session and a real Codex session: an edit triggers one review; a code question with no edits
  triggers none.
- A Claude reviewer with `--max-turns 8` still returns its structured verdict.
- A loop in a Claude chat and one in a Codex chat: no automatic reviews.
- After a day of use, compare the Copilot premium-request count with the recorded count.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-14: Step 10. A1: "Compact now" writes a real summary (M)

- [ ] Run the following steps and retain observable evidence.

**Live checks:**
- Compact now on a real Gemini or Copilot session and a local-model session, and on Claude if the probe fails.
  Check:
  - the summary is model-written;
  - the newest messages are whole;
  - user messages and identifiers are present;
  - the one-line reply comes with no tool calls;
  - the divider and tooltip wording.
- A long real session (over 96K tokens of text) on the Windows PC's helper model. Record the time taken, model
  versus basic fallback, and the "skipped N of M" line.
- A typed `/compact` in a Claude session gives no 60-second send error.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-15: Step 11. A3: Loop rounds stop re-sending the full instructions (M)

- [ ] Run the following steps and retain observable evidence.

**Live checks:**
- A real Claude same-session loop of 3 or more rounds. Confirm the rounds after the first ran a confirmed
  `--resume`, and that the card was sent.
- A loop that crosses Claude's auto-compact threshold, or a manual `/compact` in a borrowed chat between rounds.
  Confirm the boundary arrives, and that the next round is a full re-anchor.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## LT-P0-16: Step 12. A2: Harness's instructions reach ACP sessions; Codex stops getting duplicates (S-M)

- [ ] Run the following steps and retain observable evidence.

**Live checks:**
- An OpenCode 2.x root session:
  - the log shows "delivered" at 26-46K characters with no cut;
  - the reply reflects your global rules;
  - plan mode reports that it is read-only.
- A Copilot root session in this repo: the first `user.message` has the block, and `system.message` holds AGENTS.md
  twice, not three times.
- The Copilot custom-instructions probe, to set up the later native-file route:
  - In a temp folder, create `AGENTS.md` and `.github/instructions/aio.instructions.md`, each with its own sentinel
    line, and put a third sentinel in the profile home.
  - Run `copilot --acp --stdio --config-dir <profile home>` with `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<temp>`.
  - Record which sentinels appear in the persisted `system.message`.

Why deferred: this check exercises a rebuilt running application, real provider/service behavior or human visual judgment beyond the automated fixtures.

## Historical stranded runs (Step 2.6)

- [ ] James uses the new confirmed Close action on the five historical paused/parked runs, and the 17 September provider-limit run only if desired. Re-run the read-only query in root `_scratch/oct-phase0/b1-loop-quick-fixes.md` section 6a. Expected: selected rows are cancelled with end timestamps and matching checkpoint state; the chosen rows no longer match the stranded query. This changes James's retained history and requires his selection; it was not performed automatically.

## Full-day accounting and repaired history (Steps 7b–7d)

- [ ] After one complete local calendar day on the rebuilt app, run `rtk npm run audit:claude-cost -- --compare-transcripts --day YYYY-MM-DD --json`. Expected: stored versus native transcript-priced Claude total differs by at most 5%; inspect largest session gaps, one-sided sessions, model totals and the printed caveats. Use `--prices <json>` for deliberate rate overrides. `--projects <directory>` supports isolated copied transcript evidence; normal runs include the native and profile project trees. Why deferred: one full post-change day and provider-generated transcripts do not yet exist.
- [ ] On first rebuilt startup against James's real profile, compare `cost_entries_a0_backup` with the original pre-cutoff values and check both `a0-per-turn-booking-live` and repair completion markers. Confirm no post-cutoff row is backed up or changed. Run the audit for a repaired sample day. Expected: backup equality, no rows at/after cutoff altered, repair only once, repaired Claude day within 5%. Why deferred: the live migration and startup repair must run in the intended rebuilt application; temporary SQLite fixtures already cover transactions, rollback/retry, cutoff, counters and idempotence.
- [ ] Run two resident Claude turns and a same-session three-round loop in the rebuilt app. Query their `cost_entries` and `loop_iterations` respectively. Expected: turn dollars and round cents sum to the final native session total (allow only cents rounding in loop rows), with side-model child rows separate from main token counts. Why deferred: live provider sessions and rebuilt runtime wiring are required; adapter/proxy ledger fixtures and real CostTracker integrations provide the in-loop evidence.

## Recorded session cost (Step 8)

- [ ] Enable `showCost`, send two priced Claude turns and watch during the second turn. Expected: header retains the first recorded amount while the provider is busy and then shows the sum of recorded turn costs; narrow-window layout remains readable. Disable the setting and confirm both header and footer omit cost.
- [ ] Hibernate, wake and send another Claude turn. Query `SUM(cost)` for that session in `cost_entries`. Expected: the header equals that sum, never the native cumulative result or a context-occupancy estimate. Why deferred: rebuilt application hibernate/wake and real provider session persistence are required.

## Helper routing and day records (Steps 7a/7e)

- [ ] Invoke title, reviewer, fresh-eyes/review CLI (if an external launcher sets `AIO_COST_ATTRIBUTION_DIR`), synthesis, compare, council, magic prompt, verification, automation, channel and local/basic summary paths. Inspect the day's JSONL. Expected: each actual dispatched model call has its intended purpose, winner provider/model and cost source; cancellation/error preserves reported paid usage and unknown calls remain explicit.
- [ ] Exercise no-API-key deterministic summary and title failures. Expected: basic summary is `aio-basic-summary` with known free zero, and each dispatched title failure has its actual provider and unknown/error status rather than an invented price.
- [ ] Run the Step 7e read-only SQL check after the rebuilt helper paths finish. Expected: no finished post-change frontier routing row has null provider. Why deferred: persisted production routing rows must originate from the rebuilt helper paths; isolated fixtures verify the sink and winner handling.

## Native probe evidence already obtained

Claude CLI 2.1.296 headless probes passed: plain and text-block `/compact` emitted `compact_boundary`, retained PELICAN-42 and produced no explanatory assistant reply; the Harness-wrapped slash command produced an explanation and no boundary. Native one-shot `--resume … /compact` also emitted the boundary. A $0.001 native budget probe exited 1 with `error_max_budget_usd` and paid cost $0.0064186; its final counters were zero, while the assistant carried usage. Evidence is retained in the queue worktree `_scratch/native-claude-compact-probe*.json*`, `_scratch/native-claude-resume-compact.jsonl`, and `_scratch/native-budget-stop*.json*`. The $0.01 magic-prompt rebuilt integration remains a separate open check above.

## Additional runtime acceptance details

- [ ] During a helper pause, use Local AI → Retry now. Expected: a new attempt and authoritative snapshot/revision. While titleGeneration is paused, create a title; expected: plain title with no paid CLI escalation. Requires the rebuilt runtime and real worker outage.
- [ ] Send two prompts through a real Copilot session, then resume it and send another. Compare `prompt.usage` running gross/cache counters with booked rows. Expected: uncached input is delta gross minus delta cache, repeated checkpoints make no duplicate row and reseller dollar cost is zero unless explicitly reported. Requires provider-generated session usage.
- [ ] For A3, prefer automatic Claude/Codex compaction while a same-session loop progresses; the next round must send the full anchor. Manual `/compact` in a borrowed resident chat is entangled with the separately reproduced process-orphan defect and is not claimed repaired here.

## Native Copilot instruction probe — passed 11 October 2026

Installed Copilot 1.0.95-2 completed native ACP initialize/new-session/prompt against an offline localhost fixture model, with isolated profile and source directories. No external credentials or paid model call. The real outbound native instruction payload contains the workspace AGENTS sentinel and external `.github/instructions/aio.instructions.md` sentinel once each. The persisted system.message contains those native instruction blocks and their mirrored representation; the aggregate persisted counts therefore include mirrors. Profile-home AGENTS and external root AGENTS sentinels are absent. This establishes loader/discovery behavior, not semantic compliance of a real model or the rebuilt Harness root prompt.

Sanitized evidence: queue worktree `_scratch/copilot-native-instruction-discovery.json`, `_scratch/copilot-native-instructions-probe-result.json` (normalized payload and mirror counts). The Copilot probe subcheck in the Step12 section is satisfied by this dated evidence; its rebuilt-root/OpenCode checks remain open.
