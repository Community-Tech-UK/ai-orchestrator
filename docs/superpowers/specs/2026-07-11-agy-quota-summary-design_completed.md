# AGY Quota Summary Design

## Goal

Replace the obsolete Antigravity quota integration in AI Orchestrator and
`/Users/suas/work/token-usage-monitor` with the quota contract used by AGY
1.1.1, so both surfaces report the same five-hour and weekly usage that AGY
reports for the signed-in account.

## Confirmed Failure

Both integrations currently read `~/.gemini/oauth_creds.json`, call
`POST /v1internal:retrieveUserQuota`, and parse top-level per-model daily
buckets. That legacy endpoint returns HTTP 200 with every
`remainingFraction` set to `1`, producing a technically correct but misleading
0% display.

AGY 1.1.1 stores its active consumer credential in the system keyring. On
macOS, the item uses service `gemini` and account `antigravity`. With that
credential, `POST /v1internal:retrieveUserQuotaSummary` returns grouped
five-hour and weekly quota buckets.

## Credential Handling

- Read credentials only. Never write, refresh, rotate, log, or expose AGY's
  keyring access or refresh token.
- On macOS, prefer the active Keychain item for service `gemini` and account
  `antigravity`.
- Decode the current keyring serialization as an opaque prefix followed by a
  colon and base64-encoded JSON. Read `token.access_token` and `token.expiry`.
- Treat a missing, malformed, or expired keyring credential as unavailable.
- Retain `~/.gemini/oauth_creds.json` as a compatibility fallback for older
  installs and platforms where the keyring source is not available. Existing
  refresh behavior may be used only for this fallback and must remain
  non-writing.

## Endpoint and Request

- Host: `https://daily-cloudcode-pa.googleapis.com`.
- Path: `/v1internal:retrieveUserQuotaSummary`.
- Method and body: `POST` with `{ "project": "<cloudaicompanionProject>" }`.
- Discover the project with the existing `loadCodeAssist` request using the
  same selected credential.
- Send an AGY-compatible user agent rather than the neutral legacy user agent.
- Surface 401/403 as an authentication or entitlement failure. Do not silently
  fall back to the obsolete endpoint.

## Response Mapping

Parse `groups[].buckets[]`. Each group supplies a display name and each bucket
supplies `bucketId`, `displayName`, `window`, `remainingFraction`, and
`resetTime`.

Normalize each bucket to used percentage as
`clamp((1 - remainingFraction) * 100, 0, 100)`.

Expected windows are:

1. Gemini Models, five-hour
2. Gemini Models, weekly
3. Claude and GPT models, five-hour
4. Claude and GPT models, weekly

Window identifiers must be stable and derived from provider plus bucket ID.
Labels must retain both group and window meaning. The Gemini five-hour bucket
drives token-usage-monitor's compact AG percentage because it is the immediate
capacity constraint.

Unknown future groups and buckets should still be normalized when they carry
a usable display name and remaining fraction.

## Integration Boundaries

### token-usage-monitor

- Poll the summary endpoint using keychain-first credentials.
- Teach the proxy capture path to parse summary responses.
- Keep legacy response parsing only for captured historical/older-client
  traffic; the poller must not use the legacy endpoint.
- Write the existing `~/.usage/state.json` schema so current consumers remain
  compatible.

### AI Orchestrator

- Add a focused AGY credential reader beside the existing Claude and Cursor
  credential readers.
- Update `GeminiUsageEndpointProbe` to consume that reader and parse summary
  groups.
- Preserve the existing `ProviderQuotaSnapshot` contract and composite monitor
  fallback.
- Remove legacy daily-family assumptions from the native AGY probe and its
  tests.

## Error Handling

- Credential reads fail closed and return a reauthentication snapshot without
  leaking credential material.
- Network timeouts, non-JSON responses, empty group lists, and buckets without
  numeric remaining fractions produce explicit failed snapshots or no state
  update, following each project's existing conventions.
- A successful response with future unknown groups is accepted when at least
  one valid bucket can be normalized.

## Verification

- Add regression tests before implementation and observe them fail against the
  legacy behavior.
- Test keychain decoding, keychain preference, file fallback, expiry handling,
  summary parsing, unknown groups, and the selected primary window.
- Run token-usage-monitor's Python tests.
- Run AI Orchestrator's targeted quota tests, then its canonical TypeScript,
  lint, LOC, and quiet-test gates.
- Perform one read-only live summary request and confirm both normalized
  surfaces agree with its percentages.

## Non-Goals

- No TUI `/credits` scraping.
- No credential writes or token rotation.
- No UI redesign.
- No changes to providers other than Antigravity.
- No commits or pushes.
