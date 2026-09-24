# WS13 Hardened Run Mode (Seatbelt) — Live Test

## Status — 2026-09-20
Open: 0 · Closed: 11 · Failed: 0
Checks 4, 7, 10 and 11 were all closed on 2026-09-20 — see [Evidence run — 2026-09-20](#evidence-run--2026-09-20-queue-worktree-queue2026-07-13-fable-ws13-1b04f4). No check needs James. The 2026-09-06 note that checks 10/11 needed James staging a live denial is superseded: an interrupt-suppression lever stages the denial-classified crash without a human. Two defects reproduced during the run are filed as [LT-539](livetest-remediation-register.md) and [LT-540](livetest-remediation-register.md); they are separate remediation items and do not reopen these checks.

### History
- 2026-09-06 — Open: 4 · Closed: 7 · Failed: 0. Needed an instance-id-correlated Codex re-run (check 4), `npm run dist` for check 7, and James staging a live denial-classified crash for checks 10/11. Check 5 (LT-526 re-verification) closed that day.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-07-13-fable-implementation-plan_completed.md](2026-07-13-fable-implementation-plan_completed.md) (§WS13)

**Prerequisites:** rebuilt + restarted app on macOS (`npm run build` or packaged build); at least Claude CLI installed. These checks need real provider CLIs spawning as real child processes — they cannot run against the wasm-mocked test suite. Enable hardened per instance via the **"Hardened" toggle in the new-session composer toolbar** (beside YOLO; macOS-only, default OFF).

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 1. Doctor readiness row | 2026-07-31 | `getStartupCapabilities()` returns the exact expected row verbatim: `status: "ready"`, summary "sandbox-exec verified with a live no-op probe." |
| 2. Hardened Claude instance spawns and works inside the jail | 2026-07-31 | Instance `ccgzhl1a6` reached `idle`; write/read/shell all succeeded, after fixing [LT-026](livetest-remediation-register.md) (no keychain mach-lookup access) and [LT-027](livetest-remediation-register.md) (writable roots not realpath-resolved, so symlinked `/tmp` granted nothing) |
| 3. Deny write outside the writable roots | 2026-07-31 | Instance `cl8hoqtop`, write to `~/Desktop/aio-seatbelt-probe.txt` → `EPERM`; file absent afterward |
| 6. Restore keeps the jail | 2026-08-18 (Batch U) | History entry `87c40827…` (`hardened: true`) restored to instance `cjgwc9z9n`; denied write to `~/Desktop` still fails (`EPERM`) after restore, distinguished on-record from AIO's own YOLO permission gate |
| 8. Writable-root review (tighten with evidence) | 2026-08-12 | Measured 0 sandbox denials for Codex/Claude with a minimal root set; verdict "over-broad" — `~/.cache` (130 GB, unanimously unneeded) dropped from `defaultHardenedWritableRoots` in `src/main/sandbox/seatbelt.ts`; new `seatbelt.spec.ts` case watched fail pre-fix and pass post-fix; per-provider-home narrowing decided-but-deferred with written rationale (cross-provider homes like `~/.ai-orchestrator` are shared/provider-adjacent, a wrong removal fails closed) |
| 9. Create-UI toggle (slice 3) | 2026-08-12 (Batch D) | `.hardened-toggle` on the dashboard (`/`) route: present OFF, flips to "Hardened ON" (`active` class) on click, persists across a real `Page.reload()`; `hardened: true` wiring traced to `input-panel.component.ts:1659-1662`; non-mac absence traced via code (`darwin`-only computed gate), not runtime-tested |
| 5. Remote placement fails closed (LT-526 fix re-verification) | 2026-09-06 | Rebuilt `dist/main` (stale by one unrelated file) and `dist/worker-agent`; confirmed the guard string present at `dist/main/cli/adapters/adapter-factory.js:583,648`. Stood up the WS15 disposable-worker harness (isolated dev app `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-526`, from-source `dist/worker-agent/index.js` paired over loopback on port 47990) and drove `window.electronAPI.createInstance` over CDP. **Positive:** `createInstance({provider:'claude', hardened:true, forceNodeId:'26475361-…'})` — the top-level IPC call itself resolves `success:true` with a transient `local` placeholder (instance creation returns before adapter build), but the async background init then throws the exact expected message `Hardened mode is not supported for remote instances (Phase A is local macOS only).` (`app.log` "Instance background init failed", stack through `adapter-factory.js:583` → `provider-runtime-service.js:29/37` → `instance-lifecycle.js:696/1385`); `spawnTransaction.rollback()` fires and the instance is fully unregistered — `listInstances()` shows 0 instances afterward, and the disposable worker's own log (`_scratch/lt-526-worker.log`) shows zero spawn/sandbox activity for it — no unsandboxed remote session ever reached the worker. **Negative control:** the identical create without `hardened` reached `idle` with `executionLocation:{type:"remote", nodeId:"26475361-…"}` (`app.log` "CLI spawned successfully"), proving the harness could genuinely place remotely and that the hardened failure above was not caused by an unrelated harness defect. Instance terminated and harness torn down afterward (dev app, worker process, `ng serve`, `/tmp/aio-lt-526` all removed; verified no stray processes). |
| 4. Codex hardened instance forces exec mode | 2026-09-20 | Instance `x6bps8lfa`: every adapter spawn logged `Codex adapter using exec mode (app-server not available)` 86–100 ms after its own `Spawning CLI under Seatbelt hardened mode` line; the lone `app-server mode` line belongs to the WarmStartManager pre-spawn (pid 51910, `CODEX_HOME=…/codex-aio-9N7V3t`), which finally explains the 2026-07-31 contradiction. Turn completed (`SEATBELT-OK`); the per-turn `codex exec` was denied `~/Desktop` (`Operation not permitted`) while writing inside the workspace root succeeded, under `--sandbox danger-full-access` |
| 7. Packaged build ships the policy | 2026-09-20 | `Harness.app/Contents/Resources/sandbox/aio-seatbelt-base.sbpl` present and byte-identical to source (sha1 `24e8869…`), post-LT-026; `app.asar` holds **zero** copies, so only the `process.resourcesPath` branch can resolve it, and hardened mode fails closed if it cannot. Check 2's sequence re-run inside the packaged app (instance `c9va1ipus`): workspace write + read-back + `uname -s` succeeded, `~/Desktop` write denied |
| 10. Allow-and-retry lever (slice 3) | 2026-09-20 | Denial-classified crash staged with a new interrupt-suppression lever. All five assertions observed live: bar rendered; relative path rejected with `Writable-root grants must be absolute paths`; "Just retry" restarted with `writableRootCount` unchanged at 7; "Allow path & retry" on `/Users/suas/Desktop` took it to 8 and the same session then wrote there successfully; bar and notification both absent on a non-hardened errored session |
| 11. Denial notification (slice 3) | 2026-09-20 | Crash error `SIGNAL_SIGKILL` ending `…Hardened mode (Seatbelt) likely blocked file access. Use "Allow path & retry"…`; `sandbox-denial` notification "Hardened mode blocked the session" delivered; a second identical crash 2 min 45 s later recorded `delivery: "fingerprint-suppressed"` on the same fingerprint, a third 10 min 56 s after that delivered normally |

## Previously open checks — all closed 2026-09-20

The sections below are kept verbatim as the historical trail that led into the 2026-09-20 run. Each
check's current result and evidence is in [Evidence run — 2026-09-20](#evidence-run--2026-09-20-queue-worktree-queue2026-07-13-fable-ws13-1b04f4).


### 4. Codex hardened instance forces exec mode

- Steps: create a codex instance with `hardened: true`; send one prompt.
- Expected: app log shows the adapter in `subprocess-exec` mode (NOT "Codex adapter using app-server mode"); the turn completes; the per-turn `codex` process runs under `sandbox-exec`.

**Evidence trail (unresolved):** 2026-07-31 first run — FAIL: both the exec-mode and app-server-mode
log lines appeared for the same instance 389ms apart, and the session appeared unusable (`rmcp`
transport-closed errors, no answer). 2026-08-01 re-run with the production `buildSeatbeltCommand` —
the "unusable" half does **not** reproduce (4/4 jailed `codex exec` runs answered correctly, exit 0);
the `rmcp` errors are real but non-fatal and isolated to Codex's *optional remote HTTP MCP
connectors* (`chatgpt.com`/`developers.openai.com`) failing inside the jail with no corresponding
kernel sandbox denial logged — network, TLS, subprocess/stdio all confirmed working inside the jail
by direct probes. Verdict changed FAIL → PARTIAL. The mode-contradiction itself was re-analysed by
reading the adapter code (`codex-app-server-adapter.ts:272-273,298-300`, `adapter-factory.ts:671-685`)
and found structurally impossible for one adapter instance to log both lines — concluding the
original two-line observation very likely came from **two different concurrent Codex sessions**
sharing one `app.log`, not one instance. **Not re-filed as a defect.**

**What's still needed:** a clean single-instance re-run with per-instance-id log correlation to
confirm only the exec-mode line appears for that instance id, the turn completes, and `ps`/log
evidence shows `sandbox-exec`. Agent-runnable directly (dev app + a hardened codex instance + log
grep by instance id) — no rebuild or human step required.

### 7. Packaged build ships the policy

- Steps: in a packaged build (`npm run dist` output), verify `Harness.app/Contents/Resources/sandbox/aio-seatbelt-base.sbpl` exists; run check 2 in the packaged app.
- Expected: file present; hardened spawn works (resolveBasePolicyPath uses `process.resourcesPath` when packaged).

**Status:** not attempted in any evidence run. Note the check-2 fixes (LT-026/LT-027) touched
`resources/sandbox/aio-seatbelt-base.sbpl` and `buildSeatbeltCommand`, so a packaged build must be
freshly cut for this check to mean anything — an older `dist` output predates those fixes.
Agent-runnable: `npm run dist`, inspect the Resources path, then repeat check 2's spawn/read/write/
shell sequence against the packaged app.

### 10. Allow-and-retry lever (slice 3)

- Steps: drive a hardened instance into a denial-classified crash (e.g. point its CLI state home somewhere read-only, or kill the CLI after a denied startup write — check 3's deny case followed by CLI exit works if the CLI aborts). With the instance in error state, the composer shows "Hardened session exited — the sandbox may have blocked a write." Enter `/Users/<you>/Desktop` and click "Allow path & retry".
- Expected: the session restarts; `ps` shows the new sandbox-exec invocation includes a `-D WRITABLE_ROOT_n=/Users/<you>/Desktop` param; a write to Desktop now succeeds. "Just retry" restarts WITHOUT adding any root. Entering a relative path fails with "Writable-root grants must be absolute paths". The lever on a NON-hardened errored session is absent.

**Machinery confirmed wired (2026-07-31, by reading the executing path, not inferred):**
`noteSandboxDenialOnExit` called from `instance-communication.ts:2315` on every `error` exit before
the status transition; `sandbox-exit-advice.ts:35` notification title; composer lever gated by
`showHardenedDenialBar()` (`status === 'error'` AND `hardened`); absolute-path rejection at
`instance-handlers.ts:389`; not-hardened rejection at `:391`. Regression cover: `hardened-mode-
scoping.spec.ts`, 8 tests passing. Two of the four assertions (lever absent on non-hardened session;
relative-path rejection message) are already established structurally from this trace.

**Staging attempts, both unsuccessful at producing the crash:**
- 2026-08-12: `chmod 555` on a private scratch workspace before spawn — did not reproduce a crash;
  Claude Code does not do an unconditional startup write into a read-only workspace root. Negative
  result recorded so it isn't retried.
- 2026-08-24 (Batch C): redirecting `CLAUDE_CONFIG_DIR` (via a scoped `spawnProcess` monkeypatch) to
  an ungranted `~/Desktop` path — the write **succeeded** instead of being denied (3/3), i.e. this
  CLI-internal startup-config write path escapes confinement entirely, while an ordinary agent-driven
  write to the same ungranted path was still correctly denied. Filed as
  **[LT-441](livetest-remediation-register.md)** (P2 — not exploitable through any AIO-exposed
  surface today, since no `createInstance` field lets a caller set a per-instance env override).
  Not fixed. This lever therefore cannot be used to force the needed denial either.
- Directly `chmod`-ing the real shared `~/.claude` (Claude has no per-instance-isolated config home
  the way Codex's `CODEX_HOME` gives it one) was ruled out as destructive/shared-blast-radius —
  it would break every concurrent Claude session on the machine.

**What's still needed:** a genuinely safe, non-destructive lever that reliably forces a
denial-classified crash on a hardened instance's own startup write has not been found across three
sessions of trying. Needs either a new lever (e.g. a future per-instance env-override primitive) or
James staging a live denial directly and observing the composer/notification.

### 11. Denial notification (slice 3)

- Steps: repeat check 10's crash.
- Expected: crash error text ends with "Hardened mode (Seatbelt) likely blocked file access…" and a "Hardened mode blocked the session" notification appears in the notification center (deduped — a second identical crash within the cooldown does not re-notify).

**Status:** identical precondition and history to check 10 — same three staging attempts, same
result (no safe reproducible crash found; LT-441 found instead along the way, not the crash itself).
The notification/dedupe assertions have not been observed live at all (only the code path was
traced in 2026-07-31, alongside check 10's machinery). Needs the same lever as check 10, or James
staging it directly.

## Evidence run — 2026-09-20 (queue worktree `queue/2026-07-13-fable-ws13-1b04f4`)

All four remaining checks (4, 7, 10, 11) were driven to a result in this run. Two defects were
reproduced along the way and filed as [LT-539](livetest-remediation-register.md) and
[LT-540](livetest-remediation-register.md).

**Harness.** Dev app built and launched from the queue worktree with
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-c71b04f4` and `--remote-debugging-port=9611`; renderer
served from `dist/renderer-dev/browser` on `:4567` (`ng build --configuration development` +
`http-server`, per the runbook fallback). Focus emulation (`Emulation.setFocusEmulationEnabled`,
`Emulation.setPageVisibilityOverride`) was enabled on every CDP connection **before** any DOM
assertion, so `document.hidden` read `false` throughout. Dev-app main process pid **50152**; a
pre-campaign `ps` snapshot was taken before launch and used to gate every `kill -9`.

### Check 4 — Codex hardened instance forces exec mode — **PASS**

Instance `x6bps8lfa`: `provider: 'codex'`, `hardened: true`, `yoloMode: true`,
`workingDirectory: '/tmp/aio-lt-ws13-work'`.

**Exec mode, correlated per instance.** Every hardened spawn for this instance logged
`BaseCliAdapter: Spawning CLI under Seatbelt hardened mode` whose `grantedRoots[0]` is
`/private/tmp/aio-lt-ws13-work` — unique to this instance. Each *adapter* spawn (the initial one and
four respawns) was followed 86–100 ms later by `CodexCliAdapter: Codex adapter using exec mode
(app-server not available)`, all times UTC:

```
15:28:57.994 → 58.088   15:29:08.511 → 08.597   15:29:23.895 → 23.983
15:30:08.467 → 08.567   15:30:23.580 → 23.672
```

The **per-turn** spawn at 15:30:52.118 is followed 217 ms later by `CodexCliAdapter: Codex exec
escalated idle budget startup → turn on first stdout` rather than a mode line — a `codex exec`
code path, because a per-turn exec does not re-run the app-server-vs-exec decision. **No
`app-server mode` line ever follows a hardened spawn for this instance.**

**The 2026-07-31 mode contradiction is explained, not just attributed.** One
`CodexCliAdapter: Codex adapter using app-server mode` line did appear, at 15:28:58.369 — 281 ms
after the hardened instance's exec-mode line, and in an isolated profile containing exactly one
instance. It belongs to the **WarmStartManager pre-spawn**, not to the hardened instance:

```
15:28:58.088  CodexHomeManager  Created Browser Gateway MCP CODEX_HOME  (hardened instance)
15:28:58.088  CodexCliAdapter   Codex adapter using exec mode (app-server not available)
15:28:58.178  CodexHomeManager  Created session-isolated CODEX_HOME {path: …/T/codex-aio-9N7V3t}
15:28:58.368  CodexCliAdapter   App-server thread started fresh
15:28:58.369  CodexCliAdapter   Codex adapter using app-server mode
15:28:58.369  WarmStartManager  Warm process ready {provider: codex, workingDirectory: /tmp/aio-lt-ws13-work}
```

`ps` showed the corresponding process as pid **51910** (`node …/bin/codex -c
tool_output_token_limit=6000 app-server`, ppid 50152 = the dev-app main process, **not** wrapped by
`sandbox-exec`), and `ps eww -p 51910` reported
`CODEX_HOME=/var/folders/…/T/codex-aio-9N7V3t` together with
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-c71b04f4` — the same home created by the 58.178 line, in
this dev app. So a single adapter never logged both lines; the second line comes from a concurrent
warm pre-spawn inside the same process, which is why the two lines appear milliseconds apart even in
a single-instance profile. This **supersedes** the 2026-08-01 hypothesis ("very likely two different
concurrent Codex sessions sharing one `app.log`") with the observed mechanism.

**The turn completes.** `sendInput` → assistant replied exactly `SEATBELT-OK`. The `rmcp` /
`codex_models_manager` transport-closed errors from 2026-08-01 reproduce as `system` messages and
remain non-fatal — the answer still arrives.

**The per-turn process really is inside the jail.** The turn spawned
`node …/codex exec --model gpt-5.6-sol --json --sandbox danger-full-access --skip-git-repo-check`
(pid 55985, ppid 50152) directly after `Spawning CLI under Seatbelt hardened mode` at 15:30:52.118.
A single turn ran both probes:

| Probe | Result |
| --- | --- |
| `sh -c "echo hi > $HOME/Desktop/aio-lt-ws13-codex-probe.txt"` | `sh: /Users/suas/Desktop/aio-lt-ws13-codex-probe.txt: Operation not permitted`; file absent afterwards |
| `sh -c "echo ok > /tmp/aio-lt-ws13-work/inside.txt"` | succeeded; file present (3 bytes) |

Codex's own sandbox was `danger-full-access` for that process, so Seatbelt is the only layer that
could have produced the denial.

**Correction to the check's `ps` wording.** `buildSeatbeltCommand` (`src/main/sandbox/seatbelt.ts`)
returns `command: /usr/bin/sandbox-exec`, `args: ['-p', <policy>, '-D', 'WRITABLE_ROOT_n=…', …,
'--', <cmd>, …]`. `sandbox-exec` applies the profile and then **`exec`s the target in place**, so the
process keeps the sandbox but `ps` shows the *target's* argv. Forty `ps` samples across the whole
turn found **zero** `sandbox-exec` processes; that is expected behaviour, not a failure, and the
observable substitutes are the per-spawn log line plus the allow/deny result above. Future runs
should not read an absent `sandbox-exec` row as evidence of an unsandboxed spawn.

### Check 7 — Packaged build ships the policy — **PASS**

There is no `npm run dist` script in this repo. The packaged build used was:

```
npm run build
npx electron-builder --mac dir --arm64 \
  --config.mac.notarize=false --config.mac.timestamp=none \
  --config.mac.sign=scripts/sign-local-macos.js
```

(`npm run localbuild` is the dmg equivalent; its `rebuild:native` step was deliberately skipped —
`npmRebuild` is already `false` in `electron-builder.json` and a native rebuild would have disturbed
the shared `node_modules`.) Output: `release/mac-arm64/Harness.app`, locally signed, not notarized.

**Policy resource.** `Harness.app/Contents/Resources/sandbox/aio-seatbelt-base.sbpl` is present,
sha1 `24e8869320623e0c3d20f882800c558d8203052a` — **byte-identical** to
`resources/sandbox/aio-seatbelt-base.sbpl` in the tree, containing `(deny default)` and both LT-026
keychain clauses (`com.apple.SecurityServer`, `com.apple.securityd.xpc`), so this is a
post-LT-026/LT-027 build as the check requires.

**`process.resourcesPath` is the only path that can work.** `app.asar` contains **zero** entries
matching `aio-seatbelt`, so `resolveBasePolicyPath`'s dev fallback
(`__dirname/../../../resources/sandbox/…`, which resolves *inside* the asar when packaged) cannot
resolve. `loadBasePolicy()` throws when the file is missing — hardened mode fails closed — so a
successful hardened spawn in the packaged app can only come from the `app.isPackaged` →
`process.resourcesPath` branch.

**Check 2 repeated in the packaged app.** Launched isolated as
`HOME=/tmp/aio-lt-pkg-home CFFIXED_USER_HOME=/tmp/aio-lt-pkg-home
./release/mac-arm64/Harness.app/Contents/MacOS/Harness --js-flags=--max-old-space-size=8192
--remote-debugging-port=9612` (the heap flag is passed explicitly to skip
`startHarnessMainProcess`'s relaunch). Profile confirmed created at
`/tmp/aio-lt-pkg-home/Library/Application Support/harness`, so this run never touched the installed
app's profile and never contended for its single-instance lock. Hardened Claude instance
`c9va1ipus` logged `Spawning CLI under Seatbelt hardened mode {adapter: 'claude-cli',
writableRootCount: 7, grantedRoots: ['/private/tmp/aio-lt-ws13-pkg-work', …]}` and reached `idle`.
One turn ran the check-2 sequence:

| Probe | Result |
| --- | --- |
| `echo inside > /tmp/aio-lt-ws13-pkg-work/inside.txt` | succeeded; file present |
| `cat /tmp/aio-lt-ws13-pkg-work/inside.txt` | `inside` |
| `uname -s` | `Darwin` |
| `echo outside > /Users/suas/Desktop/aio-lt-ws13-pkg-probe.txt` | `sh: …: Operation not permitted`; file absent |

Two harness obstacles were hit and cleared; **neither is a product defect**, and both are recorded
so the next run does not rediscover them:

1. **The first package would not start at all** — silent `exit 0`, no window, no profile. Cause:
   `Cannot find module 'ret'` (required by `safe-regex2`, reached from
   `dist/main/core/config/settings-validators.js`). electron-builder had logged `cannot find path
   for dependency` for 124 packages because an AIO-managed worktree's `node_modules` is a **symlink
   farm** pointing into the root checkout, which its dependency walker cannot resolve. Materialising
   the unresolved entries as real directories and repackaging (three passes: 124 → 38 → 5 → 0
   unresolved) produced a build that boots. **Anyone packaging from `<repo>/.worktrees/*` will hit
   this**; packaging from the root checkout would not.
2. **The Claude CLI could not authenticate under an isolated `HOME`** —
   `Failed to authenticate: OAuth session expired and could not be refreshed`. Three controls proved
   this was the harness, not hardened mode: an **unhardened** instance in the same packaged app
   failed identically; `HOME=/tmp/aio-lt-pkg-home claude --print …` failed identically with no AIO
   involved; and the dev app on the real `HOME` answered `DEVAUTH-OK` at the same moment. Root cause:
   the login keychain is resolved from `$HOME/Library/Keychains`. Symlinking it into the temp home
   fixed it immediately (`SHELLAUTH4-OK`), after which the packaged check-2 sequence above ran.

### Check 10 — Allow-and-retry lever (slice 3) — **PASS**

**The lever that finally stages a denial-classified crash** (three earlier sessions failed to find
one; this is the reusable recipe). A hardened instance whose output buffer already holds a **real**
Seatbelt denial is **interrupted** while busy, and its CLI is SIGKILLed inside the interrupt's
suppression window. `interrupt-respawn-handler.ts:413` sets
`autoRespawnSuppressedUntil = requestedAt + INTERRUPT_FORCE_ABORT_MS + 5_000` (≈35 s), which makes
`wouldAutoRespawnIfNotRecent` false in the exit handler, so the exit takes the **terminal** branch
(`instance-communication.ts:2196-2222`) instead of auto-respawning — and that branch is the one that
calls `noteSandboxDenialOnExit`. Every `kill -9` was gated on all three runbook conditions: pid
absent from the pre-campaign snapshot, `ppid == 50152` (the dev-app main process), and the command
line matching the expected CLI.

Instance `cuappyijd`: `provider: 'claude'`, `hardened: true`, `yoloMode: true`,
`workingDirectory: '/tmp/aio-lt-ws13-deny'`. Denial staged by a genuine jail refusal —
`sh: /Users/suas/Desktop/aio-lt-ws13-deny-probe.txt: Operation not permitted`. Kill at 16:09:05 UTC →
status `error`.

| Assertion | Result |
| --- | --- |
| Composer shows the bar | `.hardened-denial-bar` rendered in the live DOM, text *"Hardened session exited — the sandbox may have blocked a write."*, input placeholder `/absolute/path/to/allow`, buttons `Allow path & retry` / `Just retry`; `showHardenedDenialBar()` returned `true` |
| Relative path rejected | typing `relative/path/to/allow` and clicking **Allow path & retry** set the UI error to exactly `Writable-root grants must be absolute paths` |
| "Just retry" adds no root | restart logged `Spawning CLI under Seatbelt hardened mode {writableRootCount: 7, grantedRoots: [… unchanged …]}`; bar cleared, status back to `idle` |
| "Allow path & retry" grants the path | `InstanceHandlers: Hardened-mode writable root granted; restarting into rebuilt jail {instanceId: 'cuappyijd', grantedPath: '~/Desktop'}` followed by `Spawning CLI under Seatbelt hardened mode {writableRootCount: 8, grantedRoots: […, '~/Desktop']}` (7 → 8) |
| Write to the granted path now succeeds | the *same* session then wrote `/Users/suas/Desktop/aio-lt-ws13-granted.txt` (content `granted`) where it had been denied minutes earlier |
| Lever absent on a NON-hardened errored session | `cw2aidbz5` (`hardened` unset) driven to `error` by the identical interrupt+kill lever → `showHardenedDenialBar() === false`, zero `.hardened-denial-bar` nodes, and zero `sandbox-denial` notifications for it |

The check's `ps`-based sub-assertion (`-D WRITABLE_ROOT_n=/Users/<you>/Desktop` visible in the
process list) is **not observable** for the same exec-in-place reason given under check 4. The
`writableRootCount: 7 → 8` log line plus the now-successful Desktop write are the equivalent
evidence and are recorded above.

### Check 11 — Denial notification (slice 3) — **PASS**

**Crash error text**, captured off the renderer's instance-batch-update channel at the moment of the
crash:

```json
{
  "code": "SIGNAL_SIGKILL",
  "message": "Process exited unexpectedly with signal SIGKILL. Hardened mode (Seatbelt) likely blocked file access. Use \"Allow path & retry\" on this session to grant the blocked path, or recreate the session without hardened mode.",
  "timestamp": 1789921365790
}
```

**Notification**, read back via `notificationList()`:

```json
{ "id": "notification-1789920545048-7", "kind": "sandbox-denial", "instanceId": "cuappyijd",
  "title": "Hardened mode blocked the session",
  "body": "The Seatbelt sandbox likely denied a file write and the CLI exited. Grant the blocked path (\"Allow path & retry\") or recreate without hardened mode.",
  "delivery": "desktop" }
```

**Dedupe.** A second identical crash 2 min 45 s later (`createdAt: 1789920709929`, 16:11:49 UTC)
recorded `delivery: "fingerprint-suppressed"` under the identical fingerprint
`{"fields":{"instanceId":"cuappyijd"},"instanceId":"cuappyijd","kind":"sandbox-denial"}` — it did not
re-notify. A third crash 10 min 56 s after the second (`createdAt: 1789921365789`, 16:22:45 UTC) delivered
normally, so the suppression is a cooldown rather than a permanent mute; the exact cooldown length
was not measured, only bracketed between 2 min 45 s and 10 min 56 s. No `sandbox-denial` notification was raised
for the non-hardened control crash.

### Levers that do NOT work — recorded so they are not retried

- **Child instance** (`parentInstanceId` set) — auto-respawn is skipped for children, which looked
  like a one-kill lever. It is not: a child is terminated and unregistered the instant its turn
  completes (`InstanceChildCompletion: Child exited, parent notified {childId: 'ce9ctx02y',
  exitCode: 0}` → `SupervisorTree: Unregistered instance`), so it can never be left sitting in
  `error`.
- **`restartInstance` to exhaust `restartCount < 5`** — the first call against an `idle` instance
  returned `{"success": false, "error": {"code": "RESTART_FAILED", "message": "Illegal transition:
  initializing → busy"}}` and left instance `crxsipi6d` wedged in `initializing`. Observed once and
  **not** investigated to root cause, so it is deliberately not filed as a defect; it needs its own
  reproduction before anyone treats it as one.
- **Repeated SIGKILLs to reach the `restartCount` ceiling** — `RespawnCircuitBreaker` backs off
  (10 s, then 30 s), and instance `ckulcy1k4` was terminated and archived at `restartCount: 4`,
  before the ceiling, with no log line naming the terminating caller. Also observed once and not
  chased.

### Cleanup performed

All six dev-app instances and the packaged-app instance terminated (`listInstances()` → 0 in both);
dev app, packaged app and the `:4567` renderer server stopped; `/tmp/aio-lt-*` workspaces and the
`~/Desktop` probe files removed; no automations were created. The packaged build is left at
`release/mac-arm64/Harness.app` (gitignored) for re-verification. The worktree's `node_modules`
retains the 167 packages materialised from symlinks in obstacle 1 above — untracked, worktree-local,
and required for any repeat of check 7 from this checkout.

## Superseded/withdrawn findings (kept for context, not action items)

- 2026-07-31's original check-4 FAIL ("session unusable") was withdrawn on 2026-08-01 evidence — do
  not re-treat it as a live failure; see check 4 above for the current, narrower open question.

> Plan Queue parked work: `queue/2026-07-13-fable-ws13-1b04f4` — 1 commit(s), reason: land-blocked.
