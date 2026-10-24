# MiMo startup warning: installed-app check

Status: pending. Prerequisites: Harness installed through its normal build/update pipeline with the MiMo startup-warning repair, then safely restarted when active sessions permit. Keep both saved MiMo usage connections and account settings intact. No feature flags are required.

Plan: [MiMo startup login warning repair](2026-10-18-mimo-startup-login-warning_plan_completed.md).

> **If a defect is reproduced:** read [the live-test campaign runbook](livetest-campaign-runbook.md), add an LT-NNN item to [the remediation register](livetest-remediation-register.md) with the matching implementation-status entry in the active remediation plan, and retain per-check evidence here. Never add new scope to a closed `_completed` plan, and never include credential material.

## 1. Observe the first usage check after a normal restart

- [ ] With the updated installed app running and global pause off, James opens the usage details and observes ComTechSpare through its initial read. Do not disconnect, delete or deliberately expire a real login.
- Expected: the saved usage connection remains present; ComTechSpare receives its current Max-plan quota without a false missing/expired-login instruction. A genuine missing or rejected login must still offer sign-in.
- Record: installed build identification, startup time, first account reading time and warning text if one appears. Record account labels and boolean success/failure only; no cookies, request URLs, tokens, passwords, raw API bodies or screenshots containing credentials.
- Why deferred: this session and other active agents depend on the installed main process. A rebuild alone does not replace its loaded code, and restarting it would interrupt those sessions. The fixed production probe, real saved login in an encrypted temporary copy, local storage recovery/cancellation regressions and production Angular component/store state rendering are verified in-loop.

## Investigation limits

The historical startup warning was not captured in available logs. The repair addresses two reproduced false-warning paths, rather than claiming proof that either caused that exact event. The optional interactive preview on `windows-pc` was blocked by access to its temporary host service and unsupported remote server setup; a headless DOM run of the actual Angular component/store verified all four states without opening a Mac browser. Interactive browser work must still preflight and target `windows-pc`; the local Harness UI remains off-limits to Computer Use.
