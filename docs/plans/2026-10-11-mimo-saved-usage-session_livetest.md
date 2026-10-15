# MiMo saved usage session: live verification

Status: pending human/Xiaomi verification. Prerequisite: restart the rebuilt Harness instance containing this change; use James's real MiMo accounts. The automated checks cover the renderer, IPC, persistence, renewal and cancellation paths with placeholder credentials. They do not prove Xiaomi accepts an embedded real login or complete a human verification challenge.

Owning plan: [MiMo usage without Chrome](2026-10-11-mimo-saved-usage-session_plan_completed.md).

Remediation flow: read [live-test campaign runbook](livetest-campaign-runbook.md) before a campaign. A reproduced defect gets a new LT-NNN index/detail entry in [remediation register](livetest-remediation-register.md) and a matching implementation-status section in [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md). Keep per-check evidence here; never include cookies, passwords, keys, sensitive URLs or screenshots containing credentials. Rename this file `_livetest_completed.md` only when every check passes.

## 1. Initial Xiaomi login and usage without Chrome

- Open Settings, Claude, Codex & MiMo Accounts. Pick ComTechSpare (the account with no Chrome association); it may remain disabled for session routing.
- Click Connect usage. The account-named Xiaomi sign-in window opens. Sign in to the same Xiaomi account that owns this account's Token Plan; complete any human challenge normally.
- Expected: after complete console cookies exist, the window closes automatically. Click Refresh in Accounts; it says Usage session saved and offers Disconnect usage. Refresh the OpenCode usage chip; ComTechSpare now has its own real plan/monthly figures and reset time rather than the missing-Chrome message.
- Close Chrome and leave Harness open past the 15-minute account polling interval. Expected: this account's updated time advances without Chrome running.
- Why deferred: requires real Xiaomi sign-in and any human challenge, in a restarted built app. Agents may not control the Harness itself or use a local Mac browser.

## 2. Restart, identity and account separation

- Connect usage for SuasMimo separately, signing in to its own Xiaomi account. Compare each account's figures with its own MiMo console; do not assume the API key can identify the console login.
- Quit and restart Harness, leaving Chrome closed. Refresh the OpenCode quota chip.
- Expected: each saved account retains its own allowance; neither reads a different account's Chrome session. Verify the two accounts' observed plan figures/reset dates against their own consoles, even if coincidentally equal.
- Why deferred: account ownership and real figures need James's actual sessions and an application restart. Encrypted restart recovery and separation are covered automatically with placeholders.

## 3. Reauthentication, disconnect and fallback

- If a real session is rejected naturally, expect renewal from that same account's Xiaomi SSO when available. If renewal is rejected, the usage message directs Accounts sign-in again. Click Sign in to usage again and complete the same account's login.
- Click Disconnect usage for the account with no Chrome association. Refresh Accounts and the quota chip.
- Expected: its saved connection disappears, old figures are cleared and the chip directs Connect usage; no later pending login or poll restores it. Other accounts continue updating.
- For an account still explicitly linked to Chrome, disconnect removes only the saved login; the settings notice explains that its existing Chrome fallback may still refresh.
- Why deferred: real session expiration/renewal depends on Xiaomi. The renewal, source invalidation and pending-request/disconnect cases already have automated tests.

## Evidence

Not run against real accounts yet.
