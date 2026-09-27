# Title Escalation and Resolver Parity — Live Test

## Current status — 2026-09-27
Open: 0 · Closed: 2 · Failed: 0

Both checks passed against the rebuilt 2026-09-27 dev runtime. The original instructions and
pre-run status remain below; closure evidence follows LT-G.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. A pending or unrun check is
> not automatically a defect, but a *reproduced* one belongs there, not only here.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-08-title-escalation-and-resolver-parity_plan_completed.md](2026-09-08-title-escalation-and-resolver-parity_plan_completed.md)

**Prerequisites:** the app **repackaged and restarted**. The running
`/Applications/Harness.app` was packaged at 09:12 and contains the *parent* plan's
changes but not these — verify before running, by extracting from the asar rather
than assuming:

```bash
npx @electron/asar extract-file /Applications/Harness.app/Contents/Resources/app.asar \
  dist/main/instance/auto-title-service.js && \
  grep -c "escalation abandoned" auto-title-service.js   # expect >= 1
```

**Why these cannot run in-loop:** both are about what the routing runtime does at
runtime. The unit tests prove each log line fires for a given input; only a real
run can say which exit the escalation actually takes in production.

---

## LT-F — the escalation names its own failure (LT-533 acceptance)

This is the acceptance criterion the plan could not close. The fix made the
failure *observable*; it did not prove the escalation works.

Steps:

1. Repackage and restart. Start several new sessions with real first messages.
2. ```bash
   grep -E '"message":"AI title (escalation|generated via)' \
     ~/Library/Application\ Support/harness/logs/app.log | tail -20
   ```

Expected: one of —

| line | meaning |
|---|---|
| `AI title generated via CLI escalation` | **the escalation works.** LT-533 closes. |
| `…abandoned — no fast-tier CLI available` | detection fails inside the packaged app despite `claude`/`codex` being on PATH |
| `…abandoned — CLI adapter cannot do a one-shot send` | adapter wiring |
| `AI title escalation failed` | read `error`, `elapsedMs`, `workingDirectory` |
| `…returned unusable output` | the CLI answered but was rejected by the gates |

**If `AI title escalation failed` appears, check two things before anything else:**

- `elapsedMs` against `timeoutMs: 60000`. The identical call measured **6.95s**
  on an idle machine. Anything near 60000 means the raise was insufficient and the
  real problem is elsewhere.
- `workingDirectory`. This is `process.cwd()`, deliberately left unchanged because
  it was a hypothesis. In a packaged Electron app it may be `/` or the bundle
  directory, which is not a sensible cwd for a spawned CLI. If it looks wrong,
  that is the cause — fix it then, on evidence.

Status: **open**

## LT-G — a session's title survives the full UI round trip (LT-534 acceptance)

The data-level check is already done: deterministic drift over the live
2,000-entry history index is **0**, rail-overflow renders **0**. What that method
cannot exercise is the live-instance path through real persistence.

Steps:

1. Start a session whose first message is multi-line with a distinctive first line.
   Note the rail title exactly.
2. Terminate it so it moves to the history rail. Note the title.
3. Restore it from history. Note the title.
4. Terminate and restore once more — this is the round trip that matters, because
   a restored session's name is a fixed point and re-archival writes it back.
5. Repeat with an attachment plus a generic message (`please fix this` + a pasted
   image) — the `Pasted-image-9.png fix` case.

Expected: byte-identical at every point, in both scenarios, and stable across the
second round trip rather than converging on something new.

**Also confirm the valve does not misfire:** a session whose title is genuine
filler (e.g. first message `work`) should not flip to a different useless title
on restore.

Status: **open**

---

## Closure evidence — 2026-09-27 rebuilt dev runtime

### LT-F — closed

Session `xrewp0sr4` produced both sides of the required observable path. Antigravity first emitted
`AI title escalation failed` with `agy exited with code 1`, its provider/model, elapsed time and
working directory. The same authorized title request then continued to Claude/Haiku, emitted
`AI title generated via CLI escalation`, and persisted `Nebula audit fallback complete` as both
`displayName` and `aiTitle`.

The run found and fixed [LT-661](livetest-remediation-register.md#lt-661): selecting one installed
CLI was not enough because a pre-response infrastructure failure prevented all later eligible
providers from being tried. Focused title-service tests pass **48/48**, main TypeScript passes, the
main-process build passes, and the rebuilt runtime confirms the failover end to end.

Status: **closed — specific failed provider and successful attributed fallback both persisted**

### LT-G — closed

Three live cases completed two terminate/history/restore cycles apiece:

| case | stable title across every boundary |
|---|---|
| multiline first message | `Orion ledger complete` |
| attachment + generic message | `Pasted image 9 fix` |
| genuine filler safety valve | `aio-lt-title-20260927` |

The second termination updated the same three durable history IDs, and the second restore returned
new live instances with the same titles. The attachment payload and message history survived both
cycles. No case converged on a different title and the filler valve did not misfire.

Status: **closed — two-cycle fixed point and filler safety valve confirmed live**
