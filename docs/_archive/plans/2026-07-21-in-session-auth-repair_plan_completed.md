# In-session auth repair

**Status:** implemented; live validation deferred to
`2026-07-21-in-session-auth-repair_livetest.md`
**Created:** 2026-07-21

## Problem

When a provider's credentials expire mid-session the turn fails with e.g.
`Failed to authenticate: OAuth session expired and could not be refreshed`.
Today that lands in the generic adapter-error path (`instance-communication.ts`
~1890): the text is appended to the transcript as a `type: 'error'` message, the
instance transitions to `error`, and its adapter is force-cleaned. There is no
affordance to fix it — the user must find a terminal, sign in, and start a new
session, losing the thread.

The provider *rate-limit* path already solves the structurally identical problem
(turn fails for a recoverable external reason → park → repair → auto-resume) via
`instance-provider-limit-handler.ts` + a `quota-park` waitReason + a composer
banner. This plan mirrors that pattern for auth.

## Approach

Additive: do **not** change the existing error handling. The error message stays
in the transcript and the instance still goes to `error`. On top of that, attach
a repair affordance and an auto-resume watcher.

1. **Detect** an auth failure at the two turn-failure sites (adapter `'error'`
   event and the thrown `sendInput()` rejection) — the same two sites
   `tryParkOnProviderLimit` already covers.
2. **Confirm** with a live auth probe where one exists (`claude`, `codex`,
   `gemini` have `check*CliAuthentication()`). This matters: an OAuth-expiry
   string can come from an MCP server or a tool, not the provider, and a false
   positive would attach a misleading repair banner. Providers without a probe
   fall back to text-only detection and get no auto-resume watcher.
3. **Mark** the instance with `waitReason: { kind: 'auth-required', provider,
   since }` and stash the failed prompt.
4. **Repair** from a composer banner: `Sign in` reuses the
   `provider:run-login` launcher added on 2026-07-21 (opens a terminal running
   `claude auth login`); `Retry now` re-probes and resumes immediately;
   `Dismiss` clears the banner.
5. **Auto-resume**: while an instance is auth-parked, re-probe the provider's
   auth every 10s for up to 15 minutes. On success, revive the session
   (`SessionRevivalService.revive`, which handles the `error` status via
   history restore + native resume) and re-send the stashed prompt.

## Work items

### 1. Provider auth probe (main)
`src/main/providers/provider-auth-status.ts`
- `probeProviderAuth(provider: InstanceProvider): Promise<'authenticated' | 'unauthenticated' | 'unknown'>`
- Maps `claude`/`codex`/`gemini` to the existing `check*CliAuthentication()`;
  returns `'unknown'` for providers with no probe.

### 2. Auth-failure classification (main)
`src/main/instance/instance-auth-failure-detection.ts`
- `detectAuthFailureSignal(errorMessage): { reason: string } | null`
- Matches provider auth-expiry phrasing (OAuth session expired / failed to
  authenticate / invalid API key / not logged in / please run `<cli> login` /
  401 unauthorized). Deliberately narrow; unit-tested against both the real
  message from the screenshot and near-miss strings that must NOT match.

### 3. Auth repair handler (main)
`src/main/instance/instance-auth-repair-handler.ts` — singleton with
`configure()` / `getInstanceAuthRepairHandler()` / `_resetForTesting()`.
- `maybeParkForAuth({ instanceId, provider, reason, resumePrompt })` →
  `'parked' | 'already-parked' | 'skipped'`. Skips when the live probe says the
  provider is still authenticated.
- Watcher: poll `probeProviderAuth` every 10s, max 15 min; clear on resume,
  cancel, or instance termination.
- `retryNow(instanceId)` — probe immediately; resume on success, else report
  still-signed-out.
- `cancel(instanceId)` — stop watching, clear the waitReason.
- Resume = `revive(instanceId)` then `resendInput(instanceId, prompt)`.

### 4. Wiring (main)
- New `onAuthFailureTurn` dep in `instance-communication.types.ts`, invoked from
  `instance-communication.ts` at both failure sites (after the provider-limit
  check, before/alongside the existing error emission).
- `src/main/instance/instance-auth-repair-runtime.ts` builds the callbacks;
  `instance-manager.ts` calls `configure()` next to the provider-limit wiring.

### 5. IPC
- Channels `INSTANCE_AUTH_REPAIR_RETRY` / `INSTANCE_AUTH_REPAIR_CANCEL`.
- Zod schemas, handlers next to the provider-limit resume handlers, preload
  exposure, `InstanceIpcService` methods.

### 6. Renderer
- `InstanceWaitReason` gains `{ kind: 'auth-required'; provider: string; since: number }`.
- `composer-banners.component.ts` renders the auth bar with Sign in / Retry now
  / Dismiss, and surfaces the retry outcome.
- `runProviderLogin` exposed through `ProviderIpcService`.

## Verification (as built)

- Unit: 18 handler tests, 20 detection tests, 5 probe tests, 9 banner tests,
  plus 2 integration tests in `instance-communication.spec.ts` proving the
  report fires for auth-shaped failures and does not for ordinary ones.
- Gates all green: `tsc` (app + spec), `npm run lint`, `check:ts-max-loc`,
  `npm run test:quiet` — 1542 files / 15223 tests.
- Live checks deferred to `2026-07-21-in-session-auth-repair_livetest.md`
  (needs a rebuilt app and a genuinely expired provider session).

## As-built notes

- `InstanceWaitReason` was extracted to
  `src/shared/types/instance-wait-reason.types.ts` (re-exported from
  `instance.types.ts`, so no import churn): that file sat exactly on its
  700-line ceiling, and the union deserves room to document its kinds.
- Revival failure keeps the block and the banner rather than clearing them —
  clearing would leave a dead session with no affordance and a silently
  dropped turn. `retryNow` reports `unknown` (not `resumed`) in that case, and
  the watcher retries revival on its next poll.
- The 15-minute watch timeout only stops the polling; the banner and its
  manual "Retry now" survive.

## Decisions

- **No feature flag.** Today's behaviour is a dead session; a banner plus an
  auto-resume watcher is strictly better, and the underlying error stays
  visible either way.
- **Probe-confirmed, not text-only**, wherever a probe exists — avoids
  mislabelling tool/MCP OAuth errors as provider auth failures.
- **Additive to the error path**, so a false positive degrades to a stray
  banner rather than a swallowed error.
