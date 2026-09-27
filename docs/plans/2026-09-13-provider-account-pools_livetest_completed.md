# Provider Account Pools — Live Test Checklist

## Current status — 2026-09-27
Open: 0 · Closed: 0 · Moved: 8 · Failed: 0

The current rebuilt runtime has only the two legacy migration profiles and no ownership
acknowledgement, so none of the real multi-account assertions can be run without James's owned
subscriptions and interactive provider login. All eight are now one bounded campaign under
[RES-029](2026-09-27-livetest-human-external-residuals_livetest.md#res-029--real-claudecodex-account-pool-campaign).
This source document is complete as a campaign record; moving the checks does not claim they passed.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-09-13-provider-account-pools_plan_completed.md](2026-09-13-provider-account-pools_plan_completed.md)
**Spec:** [2026-09-13-provider-account-pools_spec_completed.md](../superpowers/specs/2026-09-13-provider-account-pools_spec_completed.md)

**Prerequisites (all checks):**
1. Rebuild and restart the Harness app (`npm run build`, then relaunch). Every check needs the
   new main process, the Settings → Claude & Codex Accounts tab and the session/draft account chips.
2. Two Claude subscriptions (for checks 1–4, 6, 7) and two ChatGPT/Codex subscriptions (check 5)
   that James owns. Automatic handoff requires the ownership acknowledgement in Settings →
   Claude & Codex Accounts; accept it only for accounts James owns.
3. Check 8 additionally needs the worker agent redeployed (`npm run build:worker-dist`, then the
   normal worker deployment) on a worker node, because `instance.spawn` gained `accountRoute`
   and the heartbeat gained `accountProfileIds`.
4. Never paste tokens, `auth.json` contents or Keychain secrets into this file. Record profile
   IDs, states, hashes and log event names only.

All code, unit tests, lint, both typechecks, max-loc, `build:main`, `build:renderer`,
provider-parity, contracts and IPC verification passed in-loop on 2026-09-15. Everything below
needs real provider accounts, a real macOS Keychain, a real usage limit, or a live worker.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |

## Moved checks

Checks 1–8, including their Keychain-name, onboarding, native-resume, provider-limit, exhaustion,
ambient-key isolation and worker-binding acceptance criteria, are now maintained together in
[RES-029](2026-09-27-livetest-human-external-residuals_livetest.md#res-029--real-claudecodex-account-pool-campaign).
