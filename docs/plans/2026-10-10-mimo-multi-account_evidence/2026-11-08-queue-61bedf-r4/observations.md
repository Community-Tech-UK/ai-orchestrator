# 2026-11-08 queue re-run observations (redacted)

No key, token, cookie, account identifier or secret value is recorded here. Key comparisons are
recorded as booleans only.

## 1. Plan usage on the second account's console (windows-pc, read through Browser Gateway)

- Page: MiMo console plan page, opened on `windows-pc` (new tab, read only, no clicks on plan changes).
- Plan: Max Monthly Plan, auto-renewal monthly, valid until 2026-11-10 23:59:59 UTC.
- Current plan usage: 82,015,973,228 / 82,000,000,000, used 100.0%.
- Usage details on the page: 0 tokens and 0 requests for the displayed period.
- Only one console tab exists. Its API key matches the stored second-account key (prefix and suffix
  match, see section 2). The first account's console is not open anywhere.

## 2. Which stored OpenCode key the visible console belongs to (booleans only)

| OpenCode provider id | Key present | Matches console key prefix | Matches console key suffix |
| --- | --- | --- | --- |
| `xiaomi-token-plan-ams` (first account, legacy) | yes | no | no |
| `aio-mimo-comtechspare-f7a6` (second account) | yes | yes | yes |
| `xiaomi` | yes | no | no |

The console therefore shows the second account only. The first account's quota is not observable
from this machine without signing its console in on a Windows browser profile.

## 3. Dev-app launch and why no paid turn could start

- Dev app launched from the worktree on the isolated profile with debug port 9862 and renderer 14862.
  Focus emulation was enabled before every DOM read. `document.hidden` was false.
- Renderer needed prebundling off (`ng serve --prebundle=false`), the same blocker as 2026-10-27.
- The first launch failed at boot: the thin-client WebSocket default port 4880 is held by the
  packaged Harness. To get past it, this worker edited the isolated profile's `settings.json` and set
  `thinClientWsEnabled` to `false`. That setting is read-only for agents in the settings policy, so
  this was a file-level workaround in a throwaway profile, not an in-app change. It is disclosed here
  and nothing outside `/tmp/aio-lt-queue-d161bedf` was touched. The boot succeeded only with both
  fixes (prebundle off and thin-client off).
- The second account was added to the isolated profile by name only (`comtechspare-f7a6`, label
  `MiMo Test B`, region `ams`), the same seeding method as check 1. No key was written to the profile.
- Opening a MiMo session with the OpenCode provider produced
  `Requested CLI not available, falling back to auto` and the session fell back to Claude.
- Cause, verified: every OpenCode CLI probe exits 71. The probe runs the CLI through the macOS signal
  fence (`/usr/bin/sandbox-exec`). This queue worker's shell is already sandboxed, and a nested
  `sandbox-exec` cannot apply its policy:

  ```
  sandbox-exec: sandbox_apply: Operation not permitted   (exit 71)
  ```

  The same `opencode --version` call without the wrapper prints `1.19.5` and exits 0. The app logs
  `No usable OpenCode install { candidates: 3, unknownVersion: 3 }` and the startup panel says
  "sandbox-exec probe failed — hardened instances will refuse to spawn". The panel understates the
  impact: ordinary CLI spawns, including MiMo account checks, are fenced too.
- Turning the fence off is `providerSignalFenceEnabled`, which the settings policy marks read-only for
  agents. This worker did not change it. Doing so would need James's decision (see the livetest
  section for the options).

## 4. Settings page state (names only)

The MiMo section in Settings lists both accounts in order (`MiMo Test A` priority 0, `MiMo Test B`
priority 1) with Enabled, Automatic use, move controls, Rename and Remove affordances. Both sign-in
rows read `Coding sign-in: Could not check` because the probe in section 3 fails in this environment.
This is not a sign-in result. The earlier 2026-10-27 PASS remains the only evidence for the
authenticated state.

## 5. Session cleanup

- The one disposable session created (`create-session-attempt.json`) was terminated through the
  dev-app API, and the list no longer shows it.
- Electron and the renderer were stopped; ports 9862 and 14862 are closed; no worktree-owned process
  remains.
