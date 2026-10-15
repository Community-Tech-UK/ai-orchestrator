# Session title quality: packaged-app adoption

Status: pending live verification.

Prerequisites: rebuild the packaged Harness from this checkout through the
normal local build pipeline, then restart that rebuilt instance when its active
sessions can be safely interrupted. This agent did not replace or restart the
running packaged app, and cannot interactively control Harness through Computer
Use. Main/renderer builds and source/compiled-runtime checks are recorded in the
[implementation plan](2026-09-30-session-title-quality_plan_completed.md).

Remediation flow: before running a campaign, read
[the campaign runbook](livetest-campaign-runbook.md). A reproduced defect needs a
new LT-NNN index row and full entry in
[the remediation register](livetest-remediation-register.md), plus its matching
implementation-status section in
[the remediation plan](2026-07-19-livetest-failure-remediation_plan.md).
Keep per-check evidence here. Rename this file `_livetest_completed.md` only
after every check passes.

## 1. Existing automatic numeric title

Open the Work Finder session shown in the original report (runtime instance
`cz3mwn04e`, if still present) using the rebuilt app. Inspect its detail header
and project rail. If its automatic stored name is still `1.`/`1`, the new shared
resolver should use a meaningful opening prompt or matching history title. If
neither source exists, it should show `Untitled thread`, never a bare numeric
automatic title. A deliberately manual numeric rename must remain unchanged.

Evidence: pending. This checks adoption and real persisted session inputs in the
packaged application; adoption in the running app has not been verified.

## 2. Opening and settled titles

Start a new session with `Work Finder health watchdog found delivery readiness
faults. Please investigate them.` Observe the name immediately and after the
first assistant turn settles. Both header and rail should describe the subject;
the settled name must never be a number, numbered answer or generic status such
as `Done` or `Question 5`. Normal auxiliary routing settings apply: no special
flag is required. If generation fails, the meaningful instant title remains.

Evidence: pending. Production model choice/output and packaged app event delivery
need observation after rebuilding/restarting; deterministic rejection, local
and CLI paths, contextual overwrite, and race behavior are verified in-loop.

## 3. Explicit manual name

Manually rename that session to `1.` before a naming request finishes. Send a
follow-up and allow the turn to settle. The explicit name should remain `1.` in
both surfaces and after reopening or refreshing the session list, despite being
invalid for automatic naming. Then rename it to `Watchdog checks`; that useful
manual name must also remain stable. No special flag is required.

Evidence: pending. Pure resolver and service protections pass in-loop; this final
check confirms the user rename action and restore behavior in the rebuilt app.

## Status — 2026-10-06

Open: 1 (check 1) · Closed: 2 (checks 2 and 3, reconfirmed on this tree) · Failed: 0.
LT-673's empty-list reload did not reproduce. Not renamed `_completed`: check 1 still has no
installed-app observation, and that session was already terminated on 2026-10-01.

## Evidence run — 2026-10-06

Dev app from this working tree, isolated profile `/tmp/aio-lt-1006`, CDP port 9444. Electron was
the binary itself with `--js-flags=--max-old-space-size=8192 --no-sandbox --disable-gpu` because
the agent shell's Seatbelt fence refuses Chromium's own sandbox. `ng serve` still dies on the
known `_PlatformLocation` JIT/linker error, so the renderer was the production bundle from
`npm run build:renderer`, served on port 4567. Pause-on-VPN was turned off in this throwaway
profile only.

- Check 2, again: `cmlp2srrl` was titled instantly `Work Finder health watchdog found delivery readiness faults.` and then, by the title model, `Work Finder watchdog faults` (paid-fallback notice `$0.0734`). Header and rail both showed that name. A later orchestrated session `c84m2xmrp` settled to `Ping pong test` after the assistant replied `pong`. Neither name was a number, `Done`, or a question number.
- Check 3, again: `xpstp4gxw` (Codex, orchestrated) was renamed to `1.` with `isRenamed: true`. After a follow-up turn and a renderer reload, the header and the rail both showed `1.`. A further rename to `Watchdog checks` is what both the header and `listInstances` show.
- LT-673: after `Page.reload`, `listInstances` and `stateResync` both still returned `cmlp2srrl`, and the rail still showed `Work Finder watchdog faults`. The empty-list failure did not reproduce on this build.
- Claude's weekly quota was exhausted (`rejected`, `seven_day`, UI `CC 100%`), so further Claude turns in this profile stop at the limit notice. Codex answered.

## Status — 2026-10-04

Open: 1 (check 1) · Closed: 2 (checks 2 and 3, in the dev app) · Failed: 0. One unrelated defect
found while refreshing the list (LT-673). Not renamed `_completed`: check 1 is not an installed-app
UI observation.

## Evidence run — 2026-10-04 (batch A)

Dev app on the current working tree (HEAD `3d05e250e`), isolated profile `/tmp/aio-lt-1004-a`, real
Claude sessions (`opus`, non-yolo, scratch directory `/tmp/aio-lt-1004-a-ws2`), real IPC
(`createInstance`, `sendInput`), the real renderer store's `renameInstance` (the call the header's
rename control makes), real header and rail DOM (read with focus emulation on). Launched with
`--no-sandbox` because Chromium's sandbox cannot start inside the agent shell's Seatbelt fence.
Logs: `_scratch/lt-2026-10-04/a/devapp.log` (stdout of the dev app, UTC). Raw captures:
`title-check2-*.json`, `title-check3-*.json`.

### Check 2 — opening and settled titles: PASS

Instance `c4arjx8xg`, sent `Work Finder health watchdog found delivery readiness faults. Please
investigate them.`:

- Immediately: name `New session` before the send; 377 ms after the send both the stored name and the
  UI read `Work Finder health watchdog found delivery readiness faults` (rail row and header agree;
  `AutoTitle: Auto-titled instance (instant)`).
- Contextual upgrade: `AutoTitle: AI title generated via CLI escalation` (`claude`, `haiku`, after a
  first `AI title escalation failed` warning for another provider, i.e. the escalation moved on to
  the next provider as designed): `Work Finder delivery readiness faults`. This landed while the first
  turn was waiting on a tool permission (non-yolo), so I interrupted that turn.
- Settled, with a deliberately numbered answer to try to reproduce the original defect: follow-up "Do
  not use any tools. Reply ... numbered list of five likely causes (1. 2. 3. 4. 5.)". After the turn
  settled (`idle`, assistant text starting `1. The computer that's supposed to do the work isn't
  connected...`) the name was still `Work Finder delivery readiness faults` in the store, the rail
  and the header. Never a number, a numbered answer or a generic state.
- The instant title is shown with its trailing full stop removed in the UI, as designed.

### Check 3 — explicit manual name: PASS

Instance `c2f2xhlm4`, same opening prompt (two plain sentences requested, no tools):

- Manual rename to `1.` through the store 0.7 s after the send, i.e. before the naming request
  finished (instant title logged 22:51:22.973, AI title `Work Finder delivery readiness faults`
  generated at 22:51:34.201). Main-process `listInstances()`, the store, the rail row and the header
  all read `1.` before and after that window, after the turn settled, and after a numbered follow-up
  turn settled.
- Refresh: reloaded the renderer, then re-synced the list. Main and store still `1.`, rail `1.`, header
  `1.` (see LT-673 for why a bare reload shows an empty list).
- Reopen: terminated the session and restored it from history (`restoreHistory`): the history entry
  and the restored instance `cyzkfhh7b` were `1.` (rail `1.`).
- Then renamed to `Watchdog checks` (store and main agree), sent a numbered follow-up, waited for it to
  settle: still `Watchdog checks` in store, main, rail and header; unchanged after another list
  refresh; the terminate/restore round trip restored it as `Watchdog checks` (`cqa15zrfz`).

### Check 1 — existing automatic numeric title (`cz3mwn04e`): OPEN (assessed read-only, not an installed-app UI observation)

What was and was not done: the installed app's UI was not driven (Harness is a hard-denied Computer
Use target, and the session is gone, see below). Read-only inspection of the production profile:

- `session-continuity/states/cz3mwn04e.json` (last auto-save 2026-09-30 20:08) and
  `recovery-metadata/cz3mwn04e.json`: `displayName` is `1.`, provider `claude`, account profile
  `claudecomtech-7e12`, 1,000 retained messages, only 4 user messages in that window; the earliest are
  `1) yes / 2) yes / 3) yhes` and a follow-up question, i.e. the original Work Finder opener is no
  longer retained in this persisted state. No history archive file for its thread id exists in
  `conversation-history/` (searched the files modified since 2026-09-29).
- `logs/lifecycle.ndjson`: the instance was `hibernated -> terminated` on 2026-10-01 09:55 BST, so it
  is probably no longer listed in the installed app.
- Running the compiled shared resolver (`dist/shared/types/history.types.js`
  `resolveEffectiveInstanceTitle`, built from this tree) over that persisted data: automatic name
  `1.` resolves to `Untitled thread`; if the `1.` were a manual rename it stays `1.`. That is the
  expected "no meaningful source -> Untitled thread, never a bare numeric automatic title" outcome.
  The installed `app.asar` (built 2026-10-04 19:06) contains the new resolver code
  (`isGenuineUserPrompt`), so the installed app can run it.
- Not established: what the installed app's header and rail actually display for it. This is a
  computation on persisted inputs, not an observation of the packaged UI. Residual: look at the session
  in the installed app if it is still present; otherwise accept the read-only assessment and close
  the check by decision.

### Addendum — 2026-10-04 (batch A), found later in the same campaign

Not part of checks 1 to 3, but title-related: when a dev app was started with an empty, signed-out
`CLAUDE_CONFIG_DIR`, four new sessions were all auto-titled `Not logged in · Please run /login`,
because the title escalation accepted the CLI's sign-in banner as a title. Filed as **LT-675**
(P3). Checks 2 and 3 above were run before that environment variable was set, with a signed-in Claude
home.
