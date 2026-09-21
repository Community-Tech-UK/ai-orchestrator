# Title Escalation and Resolver Parity (LT-533, LT-534)

**Status:** completed 2026-09-08, with one live check deferred
**Created:** 2026-09-08

**As-built.** All code is implemented and verified. Full suite 2027 files / 22501
tests / exit 0; `tsc` (both configs), `lint`, `check:ts-max-loc`, `build:main`,
`build:renderer` all green, each confirmed by exit code rather than by reading
piped output. Two independent completion-gate rounds both returned FAIL with real
findings, which were fixed; see "Gate history" at the end.

**Not verified:** that the CLI escalation now works. LT-533 item 1 makes the
failure *observable*; item 2 is measured insurance, not a diagnosis. Its
acceptance needs a repackaged app and is deferred to
[2026-09-08-title-escalation-and-resolver-parity_livetest.md](2026-09-08-title-escalation-and-resolver-parity_livetest.md).

Follow-up to `2026-09-08-session-title-generation-repair_plan_completed.md`. That
plan is closed and must not be edited; these are the two defects its own live test
found, filed as LT-533 and LT-534 in
`docs/plans/livetest-remediation-register.md`.

---

## LT-533 — title escalation to the CLI never fires, and every exit is silent

### Evidence

Since the 09:16 restart, `aux:titleGeneration` attribution reads:

```
21  local-fallback  (none)
 2  ollama          deepseek-r1:7b   out=450, out=380
```

September total: 4224 `local-fallback`, 395 `ollama`, **zero** CLI-provider
records — while `claude` and `codex` are both installed.

The decisive case is 09:20:31: the local model succeeded (450 output tokens),
`finalizeGeneratedTitle` correctly rejected the output, control fell through to
the CLI one-shot, and nothing came out.

### What has been ruled out, by checking rather than assuming

- **Not a missing `sendMessage`.** `ClaudeCliAdapter.sendMessage` exists
  (`claude-cli-adapter.ts:534`) and spawns its own process
  (`this.process = this.spawnProcess(args)`), so the one-shot does not depend on
  a prior `spawn()` call.
- **Not CLI detection.** `checkCli` has `which`-resolution plus candidate-path
  and file-existence fallbacks, and the app spawns Claude constantly.
- **Not the external CLI.** Measured directly:
  `/Users/suas/.local/bin/claude --print --model haiku "<the real title prompt>"`
  returned `Android tester email spam analysis` in **6.95s**.

### Root cause

**Not established.** Three exits produce this outcome and none is observable:

| exit | current handling |
|---|---|
| no provider resolved | `logger.debug('No CLI available for AI title generation')` |
| adapter cannot one-shot | `logger.debug('CLI adapter does not support one-shot sendMessage')` |
| the call threw or timed out | bare `catch { return null; }`, no logging |

Debug is not persisted (`grep -c '"level":"debug"' app.log` = 0).

This is the same silent-failure class the parent plan set out to remove. The
abandonment logging added there (B3) covers only the `!allowFrontierFallback`
branch — which, now that escalation is enabled, is the branch that never runs.

### Work

- [x] 1. Done. Five call sites in `auto-title-service.ts`: `!cliType` warn,
      `!hasSendMessage` warn, `catch(error)` warn (with elapsed, timeout, cwd and
      error), "unusable output" warn, and a success `info`. Each of the three that
      gate round 1 found untested is now mutation-verified individually — three
      separate reverts, exactly one failing test each.
- [x] 2. Done — 15s -> 60s. Justified by measurement, not guess:
      the identical call takes 6.95s on an idle machine, leaving little headroom
      for a cold CLI spawn under real load, and the `titleGeneration` slot's own
      `timeoutMs` is already 45000 — so the CLI leg is currently budgeted at a
      third of the local leg for a slower operation. **Stated honestly as
      insurance, not as a proven fix**; if the cause is elsewhere, item 1 will say
      so on the next run.
- [x] 3. Held. `process.cwd()` is unchanged; it is logged on the failure path so
      the next run shows whether a packaged-app cwd is implicated.

### Acceptance — DEFERRED

Cannot be closed in-loop: it needs the app repackaged and restarted so the new
logging actually runs. Moved to
[the livetest doc](2026-09-08-title-escalation-and-resolver-parity_livetest.md).

---

## LT-534 — the two title resolvers truncate and sanitize in opposite orders

### Evidence

```
live : "Daily health check of the Dingley Assessment servers and..."
hist : "Daily health check of the Dingley Assessment servers and"
```

Measured over the live 2,000-entry history index after the parent change:
rail-overflow renders 188 -> 0, deterministic drift 222 -> 47. This bug is part
of the residual 47.

### Root cause

`truncateForRail` appends a literal `...` when it truncates.
`sanitizeGeneratedTitle` then strips it with `.replace(/[.!?]+$/, '')`.

So the marker survives or dies purely on ordering:

- `resolveEffectiveInstanceTitle` -> `normalizeGeneratedHistoryTitlePart(displayName)`
  = sanitize, then truncate -> the `...` truncation adds last **survives**.
- `getConversationHistoryTitle` -> `normalizeGeneratedHistoryTitlePart(deriveRailTitle(...))`
  and `deriveRailTitle` has already truncated -> the later sanitize **eats it**.

Reordering one call site alone cannot fix this: whichever side receives an
already-truncated stored value loses the marker. The ellipsis has to survive
sanitization wherever it appears.

### Work

- [x] 1. Done, but **narrower than originally written**, on gate round 1's
      finding: preservation is opt-in via
      `sanitizeGeneratedTitle(value, { preserveTruncationMarker: true })` and only
      the resolvers set it. Preserving unconditionally would have dressed up raw
      model output — a model answering `"Continuing the analysis..."` would have
      been shown as though the rail had truncated it.
- [x] 2. Done. The load-bearing assertion is `endsWith('...')` on a re-derived
      title; the `live === hist` check is true by construction now that both
      resolvers share one helper, and the test says so rather than implying it
      proves more.

### LT-534b — the structural cause, now in scope

The ordering fix only moved drift 47 -> 44, which proves ordering was a small
slice. The dominant cause is that the two sides derive from **different inputs**:
the live path sees the full raw first message (with line structure and attachment
names), while the history path sees `firstUserMessage` — a 150-char preview that
`truncatePreview` (`history-manager.ts:1739`) has already whitespace-collapsed
with `text.replace(/\s+/g, ' ')`. No amount of resolver tidying can recover
information that was destroyed at archive time.

**Fix: rank a non-renamed `entry.displayName` above the re-derivation.** That
value *is* the title the live rail showed, derived by `AutoTitleService` from the
full message. Using it means the title cannot change when a session stops being
live — which is precisely the reported fault.

**This reverses a documented design decision**, so it was measured before being
made, not assumed:

```
non-renamed entries with a usable displayName : 1930
                     generic default ("Claude 3", "Session 2", …) :    0
                     empty displayName                           :    0
```

The stated reason for preferring the first message was to stay anchored to the
original task rather than drifting to short follow-ups. `displayName` is derived
from the original first message too, so that intent is preserved — and the risk
that motivated the ordering (a generic placeholder winning) does not occur even
once in 1,930 real entries. Two real cases where the stored title is strictly
better than the re-derivation:

```
displayName "Yeah do it properly but do it now"
firstUserMessage "<conversation_history> Resume mode: replay fallback…"   <- a replay block, not the user
displayName "Pasted-image-9.png fix"   firstUserMessage "Please fix this"  <- attachment name, unrecoverable
```

Seven existing tests in `history.types.spec.ts` encoded the old order (three more
than first estimated) and were updated with that rationale in the test text, not
quietly deleted. The re-derivation path retains explicit coverage.

**Known trade-off, accepted:** where a session was auto-titled from a *synthetic*
message (`appendSyntheticUserMessage` with `autoTitle`), the stored title can be
derived from something other than the literal first message. One such case exists
in 2,000 entries. Losing that is worth eliminating the drift class.

**Safety valve added after gate round 1.** Ranking `stored` unconditionally was
wrong: a restored session takes its name from this function once, never re-runs
auto-titling (`markFirstMessageReceived` suppresses the send path and restore sets
no initial prompt), and writes it back on re-archival — so the winner is a
permanent fixed point and no future derivation improvement could ever reach a bad
stored title. `rederivationBeatsStored` reopens that escape hatch: re-derivation
wins when the stored title is filler **and** the re-derivation is not. Both halves
are load-bearing — a first attempt with only the first half swapped `"work"` for
`"hi"` on two real entries, which is churn, not repair. Measured drift over the
live history index stays at 0.

**Residual, disclosed:** a stored title that is stale or low-quality without being
filler by word-set is still locked in. That is the accepted cost of stability, not
an oversight.

---

## Verification

Canonical checklist from `AGENTS.md`, plus a fresh-eyes completion gate. LT-533's
acceptance cannot be closed in-loop (it needs a repackaged app); it returns to the
livetest doc.

---

## Gate history

Two independent completion-gate rounds, both FAIL, both with findings worth having:

**Round 1** — four findings, all upheld:
1. Ranking `stored` unconditionally removed the only valve against a permanently
   entrenched bad title, via a restore round trip the reviewer traced end to end.
   The 1930-entry measurement could not have detected that class.
2. Preserving `...` inside `sanitizeGeneratedTitle` unconditionally also affected
   raw model output.
3. My mutation claim of "4 tests for LT-534" was wrong — independently it was 2
   discriminating plus 1 joint-only, and that joint test asserted a scenario my own
   reordering had made structurally unreachable.
4. Three of five LT-533 log sites had no test at all.

**Round 2** — two findings, both upheld:
1. The LOC-driven refactor left `frontLoadTitle` imported but unused. It passed
   every canonical gate (`tsc` has no `noUnusedLocals`; `ng lint` only covers
   `src/renderer`; oxlint reports it as a non-failing warning) yet violates the
   written "remove unused imports" convention.
2. This plan doc still said `active` with every box unticked while the work was
   complete, and had not split LT-533's deferred acceptance into a livetest doc.

Also actioned from round 2's non-blocking notes: the parity test's docstring
claimed more than the test proves, and now states which assertion is load-bearing.
