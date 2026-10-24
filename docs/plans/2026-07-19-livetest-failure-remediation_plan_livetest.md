# Live-test failure remediation follow-up — live validation

Status: pending rebuilt app, James's run and the independent completion gate. No check below
is claimed passed.

Plan: [Live-test failure remediation follow-up](2026-07-19-livetest-failure-remediation-followup_plan.md)
Register: [LT-707](livetest-remediation-register.md#lt-707)
Acceptance counterpart: [Phase A live checks](2026-10-20-oct2-phaseA-safety-and-truth_livetest.md)
section 1 (the LT-707 bullet closes with this run's evidence).

## Remediation flow and prerequisites

Read `docs/plans/livetest-campaign-runbook.md` before running the campaign. A reproduced defect
must have an LT-NNN entry in `docs/plans/livetest-remediation-register.md` and an
implementation-status section in the active `2026-07-19-livetest-failure-remediation-followup_plan.md`.
Per-check evidence belongs here. Rename this document `_livetest_completed.md` only after every
check passes.

Prerequisites: independent completion-gate verification of the recovery flow, coordinator
integration, a packaged build from the root checkout (`npm run localbuild`, never a worktree),
and James installing/restarting only when no live sessions would be lost. The worktree's
main/renderer build checks do not update the installed app. Do not write James's real database
or settings from scripts. Automated headless tests already cover the agent-runnable paths on
isolated fixtures (see the plan's as-built notes).

## 1. LT-707 existing-history restoration (James-controlled)

James's installation already ran the old repair; this restores the affected rows through the
LT-707 maintenance flow in a rebuilt app. No step below may be performed by an agent against
the real database.

**Read-only pre-check.** With the app stopped (or ignoring writes), open
`sqlite3 'file:<data-folder>/rlm/rlm.db?mode=ro'` (`<data-folder>` is
`~/Library/Application Support/harness` on macOS) and run:

```sql
SELECT COUNT(*),
       SUM(CASE WHEN c.cost != b.cost THEN 1 ELSE 0 END),
       SUM(b.cost), SUM(c.cost)
FROM cost_entries_a0_backup b JOIN cost_entries c ON c.id = b.id
WHERE b.model IN ('opus','opus[1m]','sonnet','sonnet[1m]','haiku','fable','fable[1m]')
  AND b.timestamp >= 1792222279000;
```

- [ ] 1. Record the timestamp and the four values. Expected: 913 backed-up rows, 338 with a
  differing current cost, original sum $4,477.681085460001, current sum $3,801.4430545550003
  (aggregates may drift only if new rows enter the backup — they cannot, the repair's
  completed marker is set; if they differ, record the actual values and continue with them).
  Also record `SELECT COUNT(*) FROM cost_entries;` and
  `SELECT name, completed_at FROM maintenance_markers WHERE name LIKE 'a0-%';`.
- [ ] 2. In the rebuilt app, open the Costs page. The "Cost history restoration" card reports
   338 of 913 checked rows differing from their originals, about $3,801.44 recorded versus
   $4,477.68 original. Those dollar figures sum the whole checked scope. If the card also
   discloses rows that "cannot be identified as affected Claude rows with confidence", record
   that count: those rows have ambiguous pre-repair provider evidence, fail closed and are
   never written; the checked-row counts exclude them.
- [ ] 3. Click **Restore original costs** and confirm. Expected result message: "Restored 338
   rows ($A → $B)." — the row count equals step 1's mismatch count. $A → $B sum **only the
   restored rows**, not the whole checked scope: do not expect step 2's $3,801.44 → $4,477.68
   here. Before clicking, record the exact expected figures read-only:

   ```sql
   SELECT COUNT(*), SUM(c.cost), SUM(b.cost)
   FROM cost_entries_a0_backup b JOIN cost_entries c ON c.id = b.id
   WHERE b.model IN ('opus','opus[1m]','sonnet','sonnet[1m]','haiku','fable','fable[1m]')
     AND b.timestamp >= 1792222279000
     AND (c.cost != b.cost OR c.input_tokens != b.input_tokens OR c.output_tokens != b.output_tokens
          OR c.cache_read_tokens != b.cache_read_tokens OR c.cache_write_tokens != b.cache_write_tokens);
   ```

   The query returns (338, $A, $B) and must match the message; $B − $A equals the step-1
   reduction, $676.238030905. (The model filter mirrors the pre-check; if step 2 recorded a
   checked-row count other than 913, the card's scope includes evidence-tagged non-alias rows
   the query misses — then compare the message against the card, and record both.)
- [ ] 4. Re-run the read-only query and the row count: mismatch count is 0 and the current sum
  equals the original sum; the backup count and original sum are unchanged; the total
  `cost_entries` row count is unchanged. Copilot/Cursor rows keep their repair corrections
  (their costs stay 0 and their token fields keep the differenced values) and rows booked after
  the repair are unchanged — sample both read-only and compare with the step-1 snapshot.
- [ ] 5. Undo cycle: click **Undo last restoration**. Expected: "Undid the restoration of 338
  rows." and the read-only query returns to 338 mismatches with the step-1 current sum. Then
  run **Restore original costs** again and confirm the state matches step 4. Both runs leave
  `cost_entries_a0_backup` intact.
- [ ] 6. Restart the app. The card reads "All 913 checked rows already match their original
   values." (or the checked-row count from step 2, if the scope differed) and no restoration
   runs at startup (the step-4 read-only values are unchanged after the restart). Any
   unverified-rows disclosure from step 2 is unchanged: those rows stay as they are.
- [ ] 7. Feed the recorded evidence back into
  [Phase A live checks](2026-10-20-oct2-phaseA-safety-and-truth_livetest.md) section 1's LT-707
  bullet and close it there.

Why deferred: the flow must touch James's real history only under his explicit action in a
rebuilt, installed app; agents must not write his data and must not install or restart
Harness.

Required flags or settings: none. The card is always present on the Costs page; it disables
**Restore original costs** when every checked row already matches or when the install's
per-turn boundary cannot be resolved from cost-attribution evidence (the pre-check query then
disagrees with the card — record both and stop). Rows disclosed as unidentifiable in step 2
are never written by any run, including the undo cycle in step 5.
