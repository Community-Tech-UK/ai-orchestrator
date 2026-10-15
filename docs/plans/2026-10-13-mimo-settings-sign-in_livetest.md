# MiMo settings: real-account usage sign-in

Status: pending human Xiaomi login.

Prerequisites: launch the rebuilt Harness containing the settings repair. The main and renderer builds are produced by `npm run build:main` and `npm run build:renderer`; no special flag is required. Use James's existing account configuration. Do not recreate accounts or change their enabled state.

Owning plan: [MiMo settings repair](2026-10-13-mimo-settings-sign-in_plan_completed.md).

Remediation flow: read [live-test campaign runbook](livetest-campaign-runbook.md) before a campaign. Record a reproduced defect as a new item in [remediation register](livetest-remediation-register.md), with matching implementation status in the active remediation plan (reopen a closed plan or create a follow-up first). Keep per-check evidence here. Never record credentials, cookies, keys, or login screenshots containing secrets. Rename this file `_livetest_completed.md` only after every check passes.

## 1. Connect the missing usage login

1. Open Settings → Claude, Codex & MiMo Accounts → MiMo → ComTechSpare.
2. Confirm the coding status and Usage sign-in are shown separately. Click **Connect usage**. The account card must show an opened Xiaomi sign-in window notice or a visible error; copying a coding command must not be reported as usage sign-in.
3. Sign in as the Xiaomi account that owns ComTechSpare's Token Plan; complete any human challenge. Never use SuasMimo's console login for the spare account.
4. Once the sign-in window closes, click **Refresh** in Accounts. Expect **Usage session saved** and **Sign in to usage again** for that account.
5. Refresh OpenCode usage. Expect ComTechSpare's own allowance and reset dates, with no missing usage login warning. Compare with that account's Xiaomi console.

Why deferred: this requires James's real Xiaomi login/account selection and any human challenge. The automated UI fixture, reader tests and IPC path verification do not authenticate a real account. The Harness app itself is a hard-denied desktop target; agents have no authority to enter credentials into it. Interactive browser work, if needed for comparison, must use the Browser Gateway on `windows-pc`, never the local Mac.

## Evidence

No real-account login was attempted or claimed. Automated UI verification uses synthetic accounts only and covers command containment, the separate action routes, and feedback visibility.
