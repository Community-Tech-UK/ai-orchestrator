# MiMo usage login/refresh token persistence

Status: implemented and independently verified (2026-10-14). All agent-runnable gates pass; the
genuine live Xiaomi checks are deferred into the
[live test](2026-10-14-mimo-usage-login-token-persistence_livetest.md) and are NOT claimed verified.
Untracked and uncommitted — no branch, worktree, commit or push was made. Chat-directed bug fix
(2026-10-14): "I keep needing to log in to MIMO code again, we should be persisting the
login/refresh tokens."

## As built

Four production changes, all in `src/main/core/system/provider-quota/`, plus regression tests:

1. `mimo-console-session-renewer.ts` — the walk stops successfully as soon as the platform has
   re-minted the `api-platform_*` session cookies, so the platform's own plain-`http://` follow-up
   hop is never fetched and the minted session is never discarded; it also returns the rotated
   account SSO cookies (`MimoRenewedSsoCookie[]`), restricted to the exact pairs the encrypted
   store persists and RFC 6265 domain-matched to the response host; a non-https Xiaomi hop is now
   logged as such instead of "left the Xiaomi hosts".
2. `mimo-token-plan-probe.ts` — `attemptSessionRenewal` returns the merged session plus the SSO
   rotations; `saveRenewed(session, sso)` runs only after a successful quota re-pull and a store
   failure warns instead of turning a live renewal into `needsReauth`.
3. `mimo-usage-credentials-reader.ts` — forwards the rotations to the store.
4. `mimo-saved-session-store.ts` — exports `isPersistableMimoSsoCookie`; `saveRenewed` merges
   rotated SSO pairs (last-wins per pair, non-persistable pairs and unusable values dropped,
   merged result strictly validated) while the existing generation/`exists`/userId fencing is
   unchanged.

Tests: real-chain replay (mint then `http://` follow-up), session-trio-only mint, SSO rotation
capture with lookalike/sibling-host rejection, `saveRenewed` forwarding, persistence-failure
tolerance, store SSO merge. Nothing outside these files changed.

## Goal

James should not have to sign in to the MiMo console ("MiMo Code" usage login) again after the
console session naturally expires. The app must keep the login alive by renewing the session
through Xiaomi SSO and persisting both halves of the credential: the rotated console session
cookies and the rotated account SSO ("refresh") cookies.

## Verified cause

Observed in `~/Library/Application Support/Harness/logs/app.log` on 2026-10-14 at 11:58, 12:28 and
13:08 UTC (three consecutive probe cycles):

```
MimoConsoleSessionRenewer  MiMo session renewal left the Xiaomi hosts — stopping the walk
```

That message means the SSO renewal walk aborted on a redirect hop failing `isAllowedHop`
(`mimo-console-session-renewer.ts`), so the probe threw away the renewal and surfaced `needsReauth`
— the UI's "Sign in again" state. The walk is the only thing standing between a natural console
session expiry and a manual re-login, so every expiry is a manual re-login.

Evidence chain:

1. The platform's real 401 body (fetched 2026-10-14) publishes the renewal entry
   `https://account.xiaomi.com/pass/serviceLogin?callback=https://platform.xiaomimimo.com/sts?sign=…&followup=http%3A%2F%2Fplatform.xiaomimimo.com%2Fapi%2Fv1%2FtokenPlan%2Fusage`.
   The chain's trailing hop is the `followup` — **plain `http://` on the platform host**.
2. `isAllowedHop` requires `https:` and reports "left the Xiaomi hosts" for anything else, so that
   hop aborts the walk as if it had left Xiaomi. The platform cookies the `/sts` hop just minted
   are returned but marked `completed: false`, and `attemptSessionRenewal` discards them.
   (Not directly observed: that this `http://` followup is *the* hop that tripped the guard in
   production. It is the only non-https URL in the platform's own renewal chain definition; every
   other hop observed live is an allowed Xiaomi host over https. The fix does not depend on which
   hop it was — see below.)
3. A live instrumented walk (cookies sourced read-only from Chrome the way
   `MimoConsoleCredentialsReader` does; only hosts/status/cookie-names printed) shows the SSO entry
   hop **rotates** `passToken`, `cUserId`, `userId`, `deviceId`, `pass_ua` via `Set-Cookie` on
   `account.xiaomi.com`. `collectSetCookies` keeps only platform-host cookies and `saveRenewed`
   replaces only the console cookies, so the rotated "refresh" credentials are dropped and the
   stored `passToken` goes stale at the first renewal attempt.
4. The same walk confirms the Chrome-held console session is currently rejected (quota retry with
   the walked cookies returns 401/401), i.e. renewal/re-login is genuinely needed right now.

## What changes

1. **Complete the walk once the console session is minted.** When the walk has collected the
   `api-platform_*` session cookies, stop successfully instead of following the trailing
   `http://` follow-up hop. The probe then re-pulls quota with the minted cookies (exactly the
   request the follow-up would have been). This is robust to whichever hop trips the guard: the
   walk no longer needs to follow anything after the mint.
2. **Persist rotated login/refresh tokens.** The walk also returns the account-host SSO cookies it
   saw rotated (`passToken`, `cUserId`, `userId`, `deviceId`, `pass_ua` on `account.xiaomi.com`,
   `cUserId` on `.xiaomi.com` — the pairs the encrypted store already allows). On a renewal whose
   quota re-pull succeeds, `MimoSavedSessionStore.saveRenewed` merges them into the encrypted
   session alongside the rotated console cookies, so the next renewal walks with fresh SSO
   credentials.
3. **Never discard a successful renewal because persistence failed.** `saveRenewed` errors are
   logged and the refreshed session is still used for the retry's snapshot.
4. Accurate stop logging: a scheme downgrade on a Xiaomi host is not "left the Xiaomi hosts".

## Risks and boundaries

- No cookie value is ever logged or persisted outside the existing encrypted, OS-keychain-backed
  store; no new secret surface. Values stay in memory exactly as today.
- SSO updates are persisted only from a walk that successfully re-minted the console session
  (an authenticated context). A bounced/unauthenticated walk can never overwrite good SSO
  credentials with anonymous ones.
- Unknown cookie pairs, foreign hosts, scheme downgrades outside the early-complete window and
  untrusted login URLs keep failing closed. Host allowlisting and cookie scoping (SSO cookies to
  account hosts only, overlay cookies to platform hosts only) are unchanged.
- The Chrome-backed fallback reader is unchanged (Chrome owns its cookies; nothing is written
  there). Coding sign-in (`opencode auth login` key in OpenCode's own store) is out of scope and
  healthy — its key is persisted by OpenCode and ACP turns are completing on it.
- No dependencies, branches, worktrees, commits or pushes.

## Checklist

- [x] Reproduce from the app log and the platform's real renewal chain; form the root-cause hypothesis.
- [x] Live instrumented walk (host/cookie-names only) confirming SSO rotation and the http follow-up.
- [x] RED tests first: real-chain replay (mint then http follow-up must still complete), SSO
      rotation capture, `saveRenewed` forwarding, persistence-failure tolerance, store SSO merge —
      6 of 58 focused tests failed against the old code (`_scratch/test-run.pid-4642.log`), then
      65/65 passed across the four touched specs after the change.
- [x] Implement the four changes above (renewer early-complete + SSO rotation capture + accurate
      stop logging; probe forwards SSO and tolerates store failure; store merges rotated SSO pairs).
- [x] Focused tests green (509 tests across `provider-quota/` + `account-pool/`);
      `tsc --noEmit`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `build:main`, `build:renderer`
      all pass.
- [x] Full quiet suite green: first run 31,458 passed / 1 failed, and that single failure was
      `browser-approvals-banner.rules.spec.ts` — another session's mid-edit uncommitted work
      (it passes in isolation and in the re-run). Background re-run: `EXIT_CODE=0`,
      2,427 files / 31,459 tests passed, 6 pre-existing skips (`_scratch/mimo-full-gate.out`,
      raw `_scratch/test-run.pid-88062.log`).
- [x] Fresh independent `task-completion-gate` **VERDICT: PASS** (scoped to the 7 task files).
      Independent reruns: 509 focused tests, all static gates, full suite green; two mutation
      checks proved the new assertions bite (early-complete disabled → 2 tests fail; SSO
      allowlist bypassed → 1 test fails); RED evidence (`_scratch/test-run.pid-4642.log`,
      6 failed / 52 passed on old code) verified. Security posture judged improved; test
      integrity clean (spec deltas purely additive).
- [x] Reviewer's single optional hardening closed: an SSO `Set-Cookie` `Domain` is now RFC 6265
      domain-matched to the response host (`domainMatches` in the renewer), so a sibling Xiaomi
      hop cannot hand over a pair for `account.xiaomi.com`. Regression test added; mutation proof
      (guard stubbed to `true` → exactly that test fails, `_scratch/test-run.pid-90376.log`);
      510 focused tests + `tsc` + `lint` green after restore. The reviewer's informational note
      (rotated SSO stored without expiry) is intentional: a fresh rotation outlives the stale
      expiry and staleness still surfaces as a failed renewal.
- [ ] Deferred live checks recorded in [the linked `_livetest.md`](2026-10-14-mimo-usage-login-token-persistence_livetest.md);
      plan renamed `_completed` only after all agent-runnable gates pass.

## Review focus

- Early-complete must not weaken the host/origin guard for hops that are still followed, and must
  not send any cookie over plain http.
- Only the exact persisted SSO pairs may be written; everything else from the walk is dropped.
- The generation/disconnect fencing in `saveRenewed` must stay intact (no resurrection of removed
  or replaced logins).
- No assertion may be weakened to make a test pass; RED evidence retained.

## Evidence

- App log renewal failures: `~/Library/Application Support/Harness/logs/app.log`
  (`MimoConsoleSessionRenewer` warns at 2026-10-14T11:58:52Z, 12:28:52Z, 13:08:53Z).
- Real 401 body and chain shape: `_scratch/mimo-walk-diag/` (hosts and cookie names only — never
  values). Scratch is disposable and gitignored.
- Saved usage sessions exist and are encrypted (`mimo-usage-sessions/{legacy,comtechspare-f7a6}.bin`).
