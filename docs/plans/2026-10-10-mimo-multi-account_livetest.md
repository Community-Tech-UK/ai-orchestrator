# MiMo multi-account live checks

Status: pending. Needs (a) James to run a rebuilt Harness (coordinator), (b) a second real
MiMo Token Plan subscription (a second Xiaomi account + `tp-…` key), and (c) a rebuilt
worker agent deployed to `windows-pc` for the remote checks.

Prerequisites:

- Coordinator: a Harness built from a tree containing the MiMo multi-account change,
  installed and launched by James. Never restart the running Harness while live sessions
  exist.
- **Worker redeploy (plan Phase 5):** `npm run build:worker-dist` in this repo, then the
  normal worker deployment to `windows-pc` (memory `worker-build-skew-breaks-browser-gateway`).
  The worker needs the new build for three things: the `opencode` branch of
  `materializeWorkerAccountRoute`, the `region` field on `instance.spawn`'s `accountRoute`,
  and the `opencode auth list`-derived `accountProfileIds.opencode` advertisement. The
  worker's deploy by `git pull` + rebuild skips the rebuild while a worker is running, so
  it needs the change committed and pushed (James must authorise) and a worker restart on
  the PC. Note: `opencode` 1.18.35 was installed on `windows-pc` on 2026-10-10
  (`npm install -g opencode-ai`); the per-account sign-ins there are check 6.
- MiMo accounts: the existing Token Plan account (the legacy profile) plus one more
  Xiaomi account with its own Token Plan key, and a second Chrome profile signed into the
  second account's MiMo console (check 7).
- Sign-in terminal: `opencode --version` must run successfully in the terminal where
  the copied command is used. The repair's isolated key-prompt/cancellation proof used
  the installed OpenCode 1.18.35 through a controlled PATH; another installed Homebrew
  executable terminated with signal 9 in the investigation. The user's everyday
  terminal PATH and native Windows execution still need live confirmation; no CLI was
  installed, replaced or reconfigured by this remediation.

Plan: [MiMo multi-account](2026-10-10-mimo-multi-account_plan_completed.md).
Repair: [MiMo multi-account remediation](2026-10-10-mimo-multi-account-remediation_plan_completed.md).

Remediation flow: [live-test campaign runbook](livetest-campaign-runbook.md). Record any
reproduced defect in [remediation register](livetest-remediation-register.md), with
corresponding implementation status in `2026-10-05-livetest-campaign-defects_plan.md` or a
new remediation plan as the runbook directs. Keep per-check evidence here; rename this
document `_livetest_completed.md` only after these checks pass.

## Checks

1. **Settings renders the MiMo pool (seeded store data).** In a dev app
   (`npm run dev`) with `providerAccountProfiles` seeded to one legacy MiMo profile and
   one `aio-mimo-*` profile (names/labels only, placeholder anything else), open
   Settings → Claude, Codex & MiMo Accounts. Expected: the MiMo section lists both
   accounts in priority order with their sign-in state; the add row offers label, Token
   Plan region (Europe/Singapore/China) and an optional Chrome profile; each account has
   Enabled, Automatic use, move up/down, Rename and (non-legacy) Remove; with two
   accounts the "When an account hits its limit" panel and the ownership acknowledgement
   appear. No file path or key-shaped string anywhere in the DOM.
   Needs NO real subscription or key — only the Harness GUI. Deferred to James because an
   agent may not open or drive the Mac's GUI without explicit permission (standing
   browser/UI rule), and the visual result needs a human looking at it.
2. **Account chip and switch banner on a MiMo session.** Start a MiMo session with the
   second account added. Expected: the account chip shows the account label in the
   session header and composer; the chip's switch list offers both accounts; an explicit
   switch moves the conversation (transcript note `[System: Account switched: …]`) and the
   next turn runs on the new account. On a quota-parked session the banner's
   "Switch account…" select lists the same accounts.
3. **A real turn on the second subscription.** Sign the second account in using the
   complete command copied from Settings (Node.js and OpenCode must be installed;
   the command temporarily registers the custom login provider), verify it in
   Settings, pick it for a new session and send a tool-using multi-turn conversation.
   Expected: turns complete on the second account's quota (its MiMo console numbers move,
   the first account's do not), and multi-turn tool use keeps working (MiMo requires
   `reasoning_content` to be passed back — probe 0.2a).
4. **Live in-place switch when the first account runs out.** On a session running on
   account A (the near-exhausted one), let A hit its limit mid-conversation. Expected:
   the "moving to another account" banner appears, the ledger records the limit against A
   (`provider_limit_events` row with A's `account_profile_id`), the conversation switches
   to B **without the process restarting** (same PID in Settings/instance details), the
   `Account switched` transcript note appears, and the interrupted message is re-sent and
   completes on B. Use a nondefault reasoning setting before switching and confirm it is
   retained by the native session, as well as the app's displayed setting. If the target
   refuses that setting, the restart fallback must show its default-setting warning;
   an in-place switch must not silently advertise the old setting. If your existing
   legacy account is in Singapore or China while the logical model is Europe, switch
   back to that account and send a turn. Compare both consoles before and after:
   only the selected legacy account must consume allowance. The session may retain
   its logical Europe model label; that label alone does not prove native account
   selection. If this is the first real exhaustion, also capture the real failure
   shape for the fixture (see check 8).
5. **Respawn fallback still works.** Hibernate the session (or restart Harness) after a
   switch, then wake/resume and send a turn. Expected: the session reloads from the shared
   OpenCode session store on the current account with full history (probe 0.2c), or, when
   no session is running at switch time, the normal respawn-and-reload handoff runs with
   the same transcript note.
6. **MiMo on `windows-pc` on the second account (new worker build).** On `windows-pc`,
   run the complete copied command for the second account in Command Prompt
   (Settings shows the exact command per machine; Node.js and OpenCode must be
   installed). Then start a MiMo session placed on `windows-pc`.
   Expected: Settings shows the account as signed in on `windows-pc`; the session spawns
   there under the account (the worker's binding check passes and the spawn's
   `OPENCODE_CONFIG_CONTENT` defines the account's provider from **the worker's own**
   `opencode models xiaomi-token-plan-<region> --verbose`); a turn completes. Repeat once
   with a machine deliberately missing the key: the spawn is refused with the
   "sign in for that account on this node" remedy, and routing prefers a machine that has
   it. For automatic switching, sign both pool accounts into the worker while leaving
   the alternative account absent from the controller's OpenCode key store. Let the
   worker session hit its limit: it must switch to the worker-authenticated alternative
   and continue the interrupted message. The controller must not reject it using local
   credentials. Repeat with the alternative absent from the worker: admission must fail
   without a successful switch notice or automatic resend on the rejected account.
7. **Per-account allowance with a second Chrome profile.** Name the second Chrome profile
   (signed into the second account's MiMo console) on the second account in Settings.
   Expected: the quota chip shows separate allowance sections per account (Plan/Monthly/
   Compensation percentages and period end), each matching that account's MiMo console
   numbers; closing Chrome or signing the console out stops only that account's numbers
   ("no allowance data", never zeros or another account's numbers); new sessions are
   steered away from an account at ≥90% while the other is used instead. Remove the
   second account's Chrome association: its allowance figures disappear without
   reading Default. Change the association while a refresh is running: old figures
   must not return. If the plan is exhausted but compensation remains, selection
   uses the compensation allowance instead of treating the account as exhausted.
8. **Capture the real exhaustion shape (fixture).** When the first real limit appears,
   record from (a) the OpenCode log `stream error` line (`AI_APICallError: …`), (b) the
   failing `session/prompt` error text (`Internal error: …`), and (c) the conversation
   ledger's `provider_event_captures`: the exact status, body and message. Add it as a
   placeholder fixture next to the Phase 0.1 shapes in
   `src/main/cli/adapters/acp-provider-limit.spec.ts` and confirm `detectErrorProviderLimit`
   still tags it (and that nothing about it is a real credential).

Why deferred: every code path above is covered by unit tests run in this session (fake
MiMo-compatible servers, scripted ACP sessions, seeded renderer stores), with one
category of exception: checks 1 and 2 need a human to operate and look at the Harness
GUI on the Mac (an agent may not open or drive the Mac's GUI without explicit
permission — the standing browser/UI rule; `npm run dev` runs current code, so no
rebuild is needed for those two). Checks 3-8 need real MiMo subscriptions and keys
(which never enter the repo) and, for check 6, a real second machine sign-in. The
running Harness keeps old code until James installs a new build for anything not
covered by `npm run dev`.
