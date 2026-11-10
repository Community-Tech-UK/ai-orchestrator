## Snapshot of 2026-10-27-mimo-account-state-remediation_history.md

# MiMo account-state remediation: round history

## 2026-11-10 queue round, item 0b24c0 (branch `queue/2026-10-27-mimo-account-state-0b24c0`)

Finding: the base already contains the account-state code (`9bb035697`, hand-merged 6 Nov),
the native-finality repair (`0389bf165`) and `vitest ^5.1.0`. No code edits were needed.

Verified present and wired (read the diff of `9bb035697`):
- `provider-account-chip.component.ts`: per-option `[selected]` bindings (LT-1008).
- `runtime-reconciler-account-handoff.ts` + `runtime-reconciler.ts`: in-place and respawn
  handoffs call `updateState` and `writeThroughIdentityLocked`; cursor kept for account-only
  changes; save failure publishes actual account and emits `ACCOUNT_HANDOFF_SAVE_WARNING` (LT-1009).
- `acp-jsonrpc-errors.ts`: redacted ACP envelope in `Error.cause` (LT-1010).

Commands (worktree, foreground):
- `npm run test:quiet -- <6 account/ACP/chip specs>`: exit 0, 6 files / 61 tests.
- `npm run test:quiet -- default-loop-native-finality, runtime-reconciler-account-handoff,
  provider-event-capture-service, provider-event-capture-maintenance specs`: exit 0, 4 files / 74 tests.
- `npm run checks`: exit 0 (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints,
  build:main, build:renderer; ran on the Windows PC, 1m47s).
- `npm run generate:ipc && generate:aliases && generate:architecture`: exit 0, `git status` clean.

Not run: full suite (verifier owns it), independent completion gate, all live checks.
Plan note: the `2026-10-27-mimo-account-state-verification/` receipts folder it links to is
not in this checkout (left on the parked branch). No runtime was created by this round.


  default. The first smoke command accidentally supplied two output-file options and failed
  in the reporter; the corrected command and its successful report are retained separately.
- LT-1012: the assigned baseline already includes the 2026-10-29 child-acknowledgement/fake-clock
  repair (`0389bf165`). The worker did not change native-finality code, assertions or timers.
  Its current real-child focused controls pass. Full-suite confirmation belongs to the verifier.
- Checks recorded: targeted account/ACP/lifecycle/formatter/toolchain suites, both TypeScript
  programs plus spec typecheck, lint, size and UI-hint checks, both production builds, alias
  and IPC regeneration with no generated diff, IPC/exports verification, benchmark smoke,
  real ACP envelope and owned-process termination. The final report lists exact commands,
  exit codes and retained output. No full suite was run by this worker.

Evidence: [current branch-owned verification receipts](2026-10-27-mimo-account-state-verification/2026-11-03-891161/).
Historical command output keeps its original paths; `retention-routing.json` maps the old
ignored evidence prefix to this Git-visible directory. The packet contains no active plan/spec.

Final focused run: 21 files / 408 tests pass with the test cache disabled and two workers.
Both TypeScript programs, spec typecheck, lint, size/UI hints, both builds and generated
alias/IPC/export checks pass. `report.json`, source seals and `commands.jsonl` retain the
actual results, including earlier red controls and failed probe/smoke attempts. After the
pre-cleanup report/seal/receipts were written, owned `dist`, local test cache and the isolated
OpenCode data/cache/snapshot/helper trees were removed. Both native probe PIDs are confirmed
gone. The worktree dependency install is retained; shared root dependencies and shared
external caches are untouched. No commit, staging, stash, branch switch, worktree creation
or document completion rename was performed. The implementation is ready for the queue's
independent verification; external acceptance and the plan remain open.

The first fresh source review was limited by its git-command approval refusal; the parent
subsequently supplied the exact working diff, including new source tests. A second fresh
source review found no defect in the save-failure fix. These were source-only reviews with
explicit limits, not an independent overall completion-gate PASS. The queue verifier still
owns the unfiltered full suite, clean-state reproduction and final verdict.

External and installed-app checks remain open in
[the dedicated live checklist](2026-10-27-mimo-account-state-remediation_livetest.md): paid
continuation after handoff/wake, current Windows worker execution, independent usage sessions,
and installed-app capture. Quota exhaustion was observed only on the account actually probed;
another account's current allowance is not inferred. No purchase, login reassignment,
credential transfer, worker deployment/restart or Mac browser/desktop interaction was performed.

