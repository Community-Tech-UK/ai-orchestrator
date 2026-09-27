# In-Session Auth Repair — Live Test Checklist

## Status — completed 2026-09-27

Open: 0 · Closed: 6 · Failed: 0 · Transferred: 1

All agent-runnable checks pass. The sole remaining packaged-app Terminal/OAuth action was removed
from this checklist and transferred to
[RES-003 in the consolidated human/external checklist](2026-09-27-livetest-human-external-residuals_livetest.md#res-003--packaged-harness-provider-sign-in-launcher-and-interactive-login).

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching active remediation implementation record. A pending or unrun
> check is not automatically a defect, but a *reproduced* one belongs there, not only here.
> Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-07-21-in-session-auth-repair_plan_completed.md](2026-07-21-in-session-auth-repair_plan_completed.md)

## Completion evidence

The credential-flip checks used a disposable dev-app process tree with `HOME` and
`AIO_DEV_USER_DATA_PATH` pointed at isolated temporary roots. This produced genuine provider
sign-out/sign-in behavior without changing James's real credential stores. Codex was substituted for
Claude where a live credential flip was required because Claude also depends on login-keychain state
that an empty `HOME` cannot isolate.

| Check | Result | Date | Evidence |
| --- | --- | --- | --- |
| 1 — Doctor Refresh picks up terminal sign-in | PASS | 2026-08-19 | Under the exact fake `HOME`, `diagnosticsGetDoctorReport({force:true})` changed Codex from degraded to ready after a verified-live isolated `auth.json` was installed; `generatedAt` advanced, proving a real re-probe instead of cached state. |
| 3 — mid-session auth failure attaches repair banner | PASS | 2026-09-20 | A genuine Codex 401 caused `Session blocked on provider auth; watching for sign-in`; the live renderer showed “Signed out of codex — sign in to resume this session,” while the transcript retained the failed turn and raw provider error. |
| 4 — automatic resume after sign-in | PASS | 2026-09-20 | On instance `x2v65lxui`, verified sign-in appeared at 18:54:46Z; by 18:54:55Z the banner was gone, the same instance was busy with `restartCount:1`, native resume succeeded, and the replayed turn answered `AUTHREPAIR-REPLAY-OK` by 18:55:03Z. Eight further polls showed no retry loop. |
| 5 — manual retry reports honestly | PASS | 2026-08-18 | Clicking **Retry now** while still signed out rendered “Still signed out — finish signing in, then try again”; no turn was re-sent. |
| 6 — dismiss | PASS | 2026-08-18 | Dismiss cleared `waitReason`, logged `Cleared auth-required block without resuming`, and stopped further probes for that instance. |
| 7 — no false banner from a tool OAuth error | PASS | 2026-09-20 | `detectAuthFailureSignal` excludes MCP/GitHub/npm/Docker-style tool OAuth errors before provider-auth matching. The focused auth-repair, login-launcher and failure-detection suites passed 68/68 on the rebuilt app. |

## Packaged launcher evidence short of the transferred operator step

In the rebuilt dev renderer, a genuinely signed-out Claude row showed the expected authentication
remediation and an enabled **Sign in** button titled “Opens a terminal already running the sign-in
command.” Earlier live DOM runs dispatched a real click with only `runProviderLogin` substituted and
rendered the expected confirmation banner. The current main-process command table maps Claude to
`claude auth login`, and the macOS launcher invokes Terminal through `osascript`. What remains in
RES-003 is specifically the signed packaged app's TCC identity plus the interactive login, not an
untested renderer or command-construction path.

## Separate investigation candidate

One 2026-09-20 dev run observed that a full renderer reload hid a still-live error-state instance
from the session list even though `window.electronAPI.listInstances()` returned it; only its history
entry rendered. This was not needed for auth-repair acceptance and was not promoted to an LT defect
because production reachability and the renderer hydration call path were not established. It remains
a targeted campaign investigation rather than a hidden pass/fail condition of this completed file.

## Cleanup

The isolated instances, dev app and static server were stopped; temporary profile, fake-home and
workspace roots were removed. No automation or setting was created, no real credential store was
modified, and no terminal or provider login was opened by the agent.
