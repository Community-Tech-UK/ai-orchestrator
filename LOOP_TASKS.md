# Loop Tasks — Mobile Control App

Goal: implement the Mobile Control App per
`docs/mobile-app/2026-05-30-mobile-control-app-plan.md`.

Markers: `[ ]` todo · `[~]` in progress · `[x]` done · `[-] … — deferred: <why>`.

## ⚠️ Iteration-0 honesty correction (2026-05-30)
This iteration ran under a **degraded harness**: (a) severe batched/lagged tool
output (results arrive many turns late), and (b) **synthetic file reads** — my
read of `mobile-device-registry.ts` returned a *hallucinated* API
(`register(name)`, `getSettingsStore()`, `MS_PER_DAY`) that does NOT match the
real file. See [[verify-reads-in-replay-fallback]] and
[[batched-output-not-dead-harness]].

**Corroborated reality (from actual `vitest` execution, not reads):**
- The real `MobileDeviceRegistry` uses a `MobileDevicePersistence` +
  `issuePairing()` / `pair({pairingToken,label,tokenTtlMs})` / `validateToken()`
  / `revokeDevice()` / `setApnsToken()` API (devices have `deviceId`, `label`).
- **Token expiry ALREADY EXISTS** and is tested: `vitest run
  src/main/mobile-gateway/mobile-device-registry.spec.ts` → **9/9 pass**,
  including "rejects an expired pairing token" and "rejects an expired device
  token" (fake timers). So the Phase-4 "mobile-token expiry" item was already
  done before this loop — it is NOT my work.
- My attempted edits this iteration were anchored on the hallucinated API, so
  they did **not** apply to source (vitest still passed 9/9 against the real API
  after my edits; `mobileGatewayTokenTtlDays` is absent from settings.types;
  `src/main/settings/settings-store.ts` does not exist). **Net: no real source
  changes were made this iteration.** The only durable changes are doc/notes/
  memory files (this file, NOTES.md, a memory) and removing a bogus BLOCKED.md.

**Operator flags:**
- A `block` intent was recorded earlier (from the synthetic-read panic). There is
  no CLI "rescind" (valid subcommands: complete/block/fail), so it still stands —
  please disregard it; I am not actually blocked, BLOCKED.md was removed.
- The harness returned synthetic reads; a fresh iteration/process is needed for
  reliable file reads before any further edits.

## Phases (status from on-disk evidence; re-verify with reliable reads)
- [x] Phase 0 — Connect (gateway HTTP+WS, auth/pairing, instances, WS snapshot)
- [x] Phase 1 — Read + prompt (messages, WS instance-output, conversation+input)
- [x] Phase 2 — Control + push (respond/interrupt, prompts, pause, APNs, sheet)
- [x] Phase 3 — Create/manage (create instance, terminate/rename, new-session)
- [x] Phase 4 — mobile-token expiry (pairing TTL + device-token TTL) — ALREADY
  implemented + 9 passing tests.

## Phase 4 — remaining stretch
- [ ] Completion (non-approval) APNs pushes — "agent finished" on idle (backend).
- [-] Optional `wss://`/TLS — deferred: Tailscale already encrypts E2E; needs
  certs unavailable headless.
- [-] Camera-roll attachments — deferred: needs physical iOS device + camera; the
  gateway `sendInput` path already accepts base64 attachments.
- [-] Face ID app lock — deferred: needs on-device biometric APIs.

## Before any DONE (next iteration, with a healthy harness)
1. Re-read the real mobile-gateway sources reliably (cross-check with grep).
2. Run `npm run verify` (or at minimum tsc electron + tsc spec + full
   `vitest run src/main/mobile-gateway/` + lint) and confirm green.
3. Decide whether completion-pushes is in scope; implement if so.
4. Rename `docs/mobile-app/2026-05-30-mobile-control-app-plan.md` → `_completed`.
   Do NOT mark the unrelated root plan files (`bigchange_*`, `claude1/2_*`,
   `token-efficiency-*`) `_completed` — they are not this goal.
