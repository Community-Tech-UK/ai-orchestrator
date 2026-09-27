# Local macOS Computer Use Signing — Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Deferred live-validation check for
> [2026-07-13-local-macos-computer-use-signing-plan_completed.md](./2026-07-13-local-macos-computer-use-signing-plan_completed.md).
> Prerequisites: a macOS machine with an installed Apple Development or Developer ID
> signing identity in the login keychain, a locally packaged arm64 build produced with
> `npm run localbuild` (which now routes through `scripts/sign-local-macos.js`), and the
> ability to grant/observe real TCC (Accessibility / Screen Recording) prompts. None of
> this is available in the headless implementation environment.
> Rename this doc `_livetest_completed.md` only when the check passes with evidence.

## Status — completed by consolidation 2026-09-27

Open here: 0 · Closed here: 2 · Transferred: 1 · Failed: 0

The only remaining clean-TCC ownership test is the same underlying check as the 11 July Computer
Use onboarding residual. It was moved into consolidated
[RES-010](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-010--packaged-macos-computer-use-permission-ownership-and-repair),
which is now the sole active owner. No open item remains in this source document.

All code, unit/integration specs (`sign-local-macos.spec.ts`, `verify-macos-helper-identity.spec.ts`,
`localbuild.spec.ts`), typecheck, lint, the LOC ratchet, and the full quiet suite already pass
in-loop (see the completed plan).

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| Step 1 — real (non-ad-hoc) signing identity; matching non-empty Team ID on `Harness.app` and nested `desktop-helper` | 2026-08-24 (re-confirmed 2026-07-29, 2026-08-18, 2026-08-19) | `codesign -dv --verbose=4` on both binaries: `Authority=Apple Development: James Lawrence (WZ2PW4Y923)`, `TeamIdentifier=GJL9WJ4S4W` on both; `node scripts/verify-macos-helper-identity.js` → "macOS desktop helper signing identity verified", exit 0; `security find-identity -v -p codesigning` shows exactly one valid, non-ad-hoc identity matching that Team ID |
| Step 2 — deep-strict codesign verification of the installed app | 2026-08-24 (re-confirmed 2026-07-29) | `codesign --verify --deep --strict --verbose=2 /Applications/Harness.app` → "valid on disk", "satisfies its Designated Requirement", exit 0 |

## Transferred residual

### Check: Signed local build attributes Accessibility/Screen Recording to Harness (steps 3–5)

Steps 1–2 are closed above. Steps 3–5 were transferred intact to RES-010 on 2026-09-27:

3. On a machine with clean TCC state for Harness's bundle id (or a fresh macOS user),
   launch the signed build, trigger the Computer Use Accessibility prompt, and confirm
   macOS Privacy & Security → Accessibility lists **Harness** — not a raw
   `desktop-helper` path.
4. Trigger the Screen Recording prompt and confirm the same attribution to Harness
   under Screen & System Audio Recording.
5. Call `AXIsProcessTrusted()` from the running Harness process (or observe that
   Accessibility-gated Computer Use actions work) and confirm it returns true only
   after the grant, with no separate prompt/grant needed for the helper.

**Expected:** both permissions attribute to Harness, matching the Team ID verified in
step 1. If Accessibility attributes to the raw helper binary instead, the signing/
packaging boundary is still wrong — do not paper over it with UI copy or tests; reopen
the plan.

**Why deferred:** requires a real Apple code-signing identity (satisfied), a packaged macOS
build (satisfied), and live TCC grant/observe interaction (not satisfied) — none of which can
run in a headless session. On every campaign pass since 2026-07-29, the packaged
`/Applications/Harness.app` has been actively running and coordinating live sessions; a
`tccutil reset` for `com.ai.orchestrator` would revoke that running app's current
Accessibility/Screen Recording grants, so it was never attempted unattended. Note: a 2026-07-18
observation that Accessibility/Screen Recording already attributed to `Harness.app` with no raw
helper row does **not** satisfy steps 3–5 — it was made on an older artifact against
**already-granted** TCC entries, which proves nothing about *first-prompt* ownership (the thing
these steps exist to test). This check overlaps with Check 1 of
[`2026-07-11-computer-use-permission-onboarding-plan_livetest_completed.md`](2026-07-11-computer-use-permission-onboarding-plan_livetest_completed.md);
either check running clean satisfies both, since they exercise the same underlying ownership
boundary.

**Blocker class:** C (macOS TCC / System Settings security panes, physical operator
interaction).

## Recommendation if this is run and fails

If Team IDs mismatch or Accessibility attributes to the helper instead of Harness, the
fix is almost certainly in how `@electron/osx-sign` is signing nested code in
`scripts/sign-local-macos.js` (signing order / entitlements / deep-sign flags), not in
the verification script. Re-run `verify-macos-helper-identity.js` directly against the
built app bundle to isolate signer output from verifier logic before changing code.
