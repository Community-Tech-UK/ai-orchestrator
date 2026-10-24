# MiMo automatic refresh: installed-app check

Status: pending. Prerequisites: Harness rebuilt and installed through the normal pipeline with the MiMo cookie normalization fix, then safely restarted when existing sessions permit. No feature flags or settings changes are needed. Keep the existing MiMo usage connections; do not deliberately expire or delete them.

Plan: [MiMo automatic refresh repair](2026-10-16-mimo-auto-refresh_plan_completed.md).

> **If a defect is reproduced:** read [the live-test campaign runbook](livetest-campaign-runbook.md), record it in [the remediation register](livetest-remediation-register.md), and link an active remediation plan. Never add content to a closed `_completed` plan. Keep per-check evidence here and never include cookies, signed URLs, tokens or credential screenshots.

## 1. Confirm the installed app refreshes both account rows

- [ ] With Harness running the rebuilt installed code and global pause off, open the usage display and note each OpenCode account's reading age. Leave it running for the existing account cadence (up to 16 minutes), without pressing Refresh or reconnecting usage.
- Expected: both accounts receive current usage readings automatically. A renewable console-session expiry returns to current numbers without repeated sign-in. App logs must not show `MiMo renewed session could not be saved` for these renewals. A genuinely invalid Xiaomi SSO login may still require sign-in.
- Evidence: timestamps of automatic updates and any fixed diagnostic messages; no credential material.
- Why deferred: the current installed app contains the old cookie collection code. Loading a rebuilt installed main process requires an app restart, which would interrupt James's active sessions. The production renewal, encrypted persistence and subsequent HTTPS refresh were already exercised successfully against an encrypted disposable copy of the real connection, with the original source digest unchanged.

The standalone monitor's live repair and fresh-process reuse are recorded in its own plan under `/Users/suas/work/token-usage-monitor/docs/plans/`.
