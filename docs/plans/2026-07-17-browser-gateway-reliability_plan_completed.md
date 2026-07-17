# Browser-gateway reliability hardening — implementation plan (2026-07-17)

Brief: `_archive/browser-gateway-reliability_prompt.md` (untracked, archived). Goal: a remote agent can
drive a long, stateful form flow in a shared logged-in tab on a remote worker without
silently losing work when the channel blips.

## Verified findings (root causes)

| # | Observed failure | Root cause (verified, file:line) |
|---|---|---|
| 1 | Silent write loss (Google Ads "Changes failed to save" while gateway returned `succeeded`) | Mutations on existing tabs report success at CDP-dispatch level. Read-back (`browser-gateway-mutation-readback.ts:38`) is DOM-only and not run on the extension path's first attempt; no detection of the app's own save-failure/session banners anywhere. No `browser_target_session_stale` code exists. |
| 2 | Node drop: handles orphaned | `rpc-event-router.ts:111` → `expireNode()` **deletes** all attachments for the node (`browser-extension-tab-store.ts:120-127`). `nodeId` is stable (generated once, persisted — `worker-config.ts:211-213`) and `profileId = existing-tab:n.<nodeId>:<windowId>:<tabId>` is deterministic, so the same tab would re-derive identical ids — the deletion is the only reason handles die on a blip that Chrome survives. |
| 3 | Tool churn across reconnect (`browser_evaluate` vanished) | WS9 deferral: non-core tools are `hidden` until revealed; reveal state lives only in the forwarder process (`McpServer.revealTools`, `mcp-server.ts:80-92`). A forwarder restart re-hides everything revealed. `browser.evaluate` is not in `BROWSER_CORE_TOOL_NAMES` (`browser-mcp-deferral.ts:35-42`). |
| 4 | `snapshot { extractionHint }` → `invalid_browser_gateway_rpc_payload` | Live bug in current tree, not only version skew: MCP tool schema advertises `extractionHint` (`browser-mcp-tools.ts:471`) and the service consumes it (`browser-gateway-service.ts:780,845`), but the RPC server validates `browser.snapshot` with `BrowserTargetRequestSchema` (`browser-gateway-rpc-server.ts:587-590`), which is `.strict()` and lacks the field (`packages/contracts/src/schemas/browser.schemas.ts:424-429`). All request schemas are `.strict()`; there is **no** version negotiation anywhere host↔bridge↔worker; the bridge (aio-mcp SEA) and main app build separately → permanent skew hazard. |

Topology (verified): MCP client → stdio forwarder in aio-mcp SEA (`browser-mcp-stdio-server.ts`)
→ unix socket → `BrowserGatewayRpcServer` (main process) → `BrowserGatewayService` →
extension command store → (local native host | remote node WS relay) → extension →
shared tab. `background.js` already supports an `evaluate` command (background.js:1210),
so app-signal scanning needs **no extension/worker redeploy**.

## Workstreams

### WS1 — Forward-compatible, versioned RPC (req 3; fixes failure 4)
- `packages/contracts/src/schemas/browser.schemas.ts`: add
  `BrowserSnapshotRequestSchema = BrowserTargetRequestSchema.extend({ extractionHint: z.string().max(2000).optional() }).strict()`;
  route `browser.snapshot` to it in `validatePayload` (bug fix).
- New dependency-free `src/main/browser-gateway/browser-rpc-contract.ts`:
  `BROWSER_GATEWAY_RPC_PROTOCOL_VERSION = 1`, `computeBrowserToolSurfaceHash(tools)`.
  Bundled into both sides (same pattern as `browser-mutation-safety.ts`).
- `validatePayload` forward-compat: on parse failure where **all** Zod issues are
  `unrecognized_keys`, strip those keys, re-parse, proceed, and emit a structured
  `schema_skew_stripped` reliability event (method + dropped keys). Type errors on known
  fields still hard-fail. Additive optional fields can then never hard-fail again,
  regardless of build skew.
- Client envelope gains `contract: { protocolVersion }` (old servers ignore unknown
  params fields — verified `parseParams` picks named fields only).
- New internal RPC `browser.report_tool_surface` (see WS2) carries the forwarder's
  protocol version + surface hash; server compares with its own and emits
  `contract_mismatch` when skewed. Recorded per instance for health.

### WS2 — Tool parity across reconnect (req 2; fixes failure 3)
- New `src/main/browser-gateway/browser-tool-reveal-store.ts` (main-process singleton):
  per-instanceId revealed-tool names + last reported tool surface (names, hash,
  protocolVersion, at, parity diff).
- New internal RPC methods (rpc-server, validated inline like the extension methods):
  `browser.tool_reveal_get` → `{ revealedNames }`;
  `browser.tool_reveal_record { names }`;
  `browser.report_tool_surface { names, revealedNames, protocolVersion, surfaceHash }` →
  `{ protocolVersion, surfaceHash, parity }`.
- Forwarder startup (deferral mode): fetch previously revealed names and reveal them
  **before** `server.start()`, so the first `tools/list` after a reconnect equals the
  pre-reconnect set. Reveals during the session are recorded fire-and-forget. Fetch
  failure degrades to core set (surfaced via health parity, never a crash).
- Structural guarantee kept: hidden ≠ unregistered — every tool remains dispatchable
  even when hidden (existing WS9 behaviour, now documented as the parity contract).

### WS3 — Target-app persistence + session-staleness detection (reqs 1+4; fixes failure 1)
- New `src/main/browser-gateway/browser-target-persistence-sentinel.ts`:
  a fixed, hardcoded scan expression (never caller input) sent via the existing
  `evaluate` extension command **directly through the command store** (bypasses the
  mutation hooks; same pattern as `postTimeoutMutationProbe`). Scans only alert-ish
  surfaces (`[role=alert]`, `[aria-live]`, `[role=status]`, snackbar/toast-like class
  names, `document.title`) against two high-precision pattern sets:
  `save_failed` (e.g. "failed to save", "couldn't save", "could not be saved",
  "changes failed to save") and `session_stale` (e.g. "you got disconnected",
  "session expired", "sign in again", "signed out"). Per-origin adapter hook adds
  patterns; ships with a Google Ads adapter (the observed banners). Returns
  `ok | save_failed | session_stale | unknown` + matched pattern (bounded, redact-safe).
- Wiring in `BrowserExistingTabOperations.sendCommand` for app-state-mutating commands
  (`click`, `type`, `fill_form`, `select`, `upload_file`, `evaluate`):
  - **Post-write scan** after a successful mutation: `save_failed` →
    `browser_target_save_rejected` error (outcome `failed`, with advice);
    `session_stale` → `browser_target_session_stale`. Scan errors → `unknown` (never
    blocks on sentinel infrastructure failure). Journaled (WS5) + reliability event.
  - **Pre-write gate**: if the node (or local channel) has a recorded disconnect newer
    than the target's last OK scan, run the scan **before** the mutation and refuse with
    `browser_target_session_stale` if stale (tells the caller to re-acquire/reload, per
    the no-blind-retry constraint).
- New MCP tool `browser.assert_persisted { profileId, targetId, expectations?[], reload? }`
  (new `browser-assert-persisted-operation.ts`, thin service delegate): runs the signal
  scan + optional `read_control` expectation read-backs, optionally after a page reload
  (defeats DOM-lies-to-you SPA states); returns `{ persisted, signalState, mismatches }`.

### WS4 — Reconnect continuity for handles (req 5; fixes failure 2)
- `BrowserExtensionTabStore.expireNode` → **suspend** semantics: attachments get
  `suspendedAt` (kept, not deleted) for a grace window (15 min); registry targets marked
  stale (existing `stale: true` convention) instead of removed; expired-for-real after
  grace (lazy sweep). Commands to suspended attachments already fail fast via the
  contact-freshness gate; after the node re-registers and the extension re-reports
  inventory, the same deterministic ids re-attach and `suspendedAt` clears — callers'
  `profileId`/`targetId`/grants (keyed by profileId) survive the blip unchanged.
- If the tab was re-created (tabId changed, same node + URL): new ids are minted as
  today, plus a `reboundFromTargetId` hint on the attachment/target (additive optional
  field on `BrowserTarget`) and an `attachment_rebound` reliability event, so callers
  learn the remap from `list_targets`/`find_or_open` instead of hunting.
- Existing heartbeat/backoff (extension watchdog, 90s undelivered-wait) is untouched.

### WS5 — Durable write journal (req 6)
- New `src/main/browser-gateway/browser-write-journal.ts`: file-backed (same storage
  pattern as `browser-workflow-checkpoint-store.ts`), per (profileId,targetId), capped
  ring (≤200 entries). Each app-state mutation records: seq, at, command, target
  descriptor (selector/uid), bounded non-secret value summary, outcome
  (`succeeded | failed | maybe_applied`), and the post-write sentinel state
  (`ok | save_failed | session_stale | unverified`). `fill_credential`/`fill_secret`
  are **never** journaled with values (command + field kinds only). Fire-and-forget —
  journal I/O can never fail a mutation.
- New MCP tool `browser.write_journal { profileId, targetId, limit? }` returns recent
  entries so an interrupted flow reports exactly what was applied+verified and can
  resume. Existing `browser.checkpoint_save/resume` stay as the coarse step-level layer
  (unchanged); the journal is the fine-grained mutation layer beneath it.

### WS6 — Health preflight (req 7)
- `BrowserGatewayHealthReport` additions (all additive):
  `contract: { protocolVersion, expectedToolCount, expectedSurfaceHash }`;
  `mcpSessions: [{ instanceId, protocolVersion, schemaMatch, toolParity: { reportedCount, missing[] }, reportedAt }]`
  (from the reveal store); `recentReliabilityEvents` (ring buffer tail, WS7).
  Green = safe to start a 50-step flow: fresh contact + empty queue + schemaMatch +
  full tool parity.

### WS7 — Observability (req 8)
- New `src/main/browser-gateway/browser-reliability-events.ts`: main-process ring buffer
  (200) + structured logger lines. Kinds: `node_disconnect`, `node_reconnect`,
  `schema_skew_stripped`, `contract_mismatch`, `tool_surface_restored`,
  `tool_surface_diff`, `write_rejected_save_failed`, `write_rejected_session_stale`,
  `attachment_suspended`, `attachment_restored`, `attachment_rebound`. Emitters wired in
  the bridge contact transitions, `validatePayload`, sentinel, reveal restore, tab store.
  Never logs URLs beyond origin, never cookies/tokens/values.

### WS8 — Tests, docs, verify
- Unit: contracts snapshot schema; validatePayload strip+skew (rpc-server spec);
  reveal store + forwarder restore (deferral spec); sentinel classification + pre/post
  hooks (new spec + existing-tab ops); journal store; tab-store suspend/restore/rebind;
  health additions; assert_persisted op.
- Integration (`browser-gateway-reliability-reconnect.spec.ts`): scripted multi-step
  flow against the test-helper service; force node disconnect mid-flow; assert
  (a) tool surface identical after simulated forwarder restart, (b) stale-session write
  → error not success, (c) journal reports exactly what persisted, (d) additive unknown
  optional field never hard-fails.
- Gates: `tsc`, `tsc -p tsconfig.spec.json`, `npm run lint`, `check:ts-max-loc`,
  `test:quiet` (full suite at the end).
- Docs: extend `~/work/aio-remote-browser-gotchas.md` (new error codes, assert-persisted,
  health fields, parity guarantee); `_livetest.md` for checks needing a rebuilt app +
  `build:aio-mcp-dist` + live worker (real reconnect against windows-pc; extractionHint
  end-to-end with the live bridge).

## What could break / guardrails
- Post-write scans add one `evaluate` round-trip per mutation on existing tabs. Bounded
  expression over alert surfaces only; scan failure degrades to `unknown` and never
  blocks. No blind retries anywhere (constraint preserved).
- Strip-unknown-keys must not weaken security-relevant validation: stripping applies
  only to `unrecognized_keys` issues; known-field type errors still reject; extension
  auth/rate-limit paths untouched.
- Suspend-not-delete must not leak attachments: grace-window sweep + real deletion,
  registry marks stale so `list_targets` stays honest (existing convention).
- Preserve every behaviour in the gotchas doc: anti-throttle, wedged-renderer, channel
  error taxonomy, single-issue no-blind-retry, grants/approvals — no changes to those
  code paths except additive events.
- aio-mcp SEA: forwarder-side changes (deferral restore, envelope version) require
  `build:aio-mcp-dist` to take effect live — recorded in the livetest doc.

## Status — IMPLEMENTED 2026-07-17
- [x] WS1 RPC forward-compat + versioning
- [x] WS2 tool parity
- [x] WS3 sentinel + assert_persisted
- [x] WS4 reconnect continuity
- [x] WS5 write journal
- [x] WS6 health
- [x] WS7 events
- [x] WS8 tests/docs/gates (gates: tsc, tsc-spec, lint, ts-max-loc, full test suite green)

Live validation (rebuild + worker + real SPA) is deferred to
[`2026-07-17-browser-gateway-reliability_livetest.md`](2026-07-17-browser-gateway-reliability_livetest.md).

## As-built deviations from the plan
- `browser.assert_persisted` has **no `reload` option** (planned as optional): reloading a
  shared tab can itself destroy unsaved user state, so the caller must navigate/reload
  explicitly and then assert. Read-backs + failure-signal scan only.
- The write journal stores **no value digests** (planned "value hash") and only an
  `approxValueLength` rounded up to a multiple of 8 — the credential/secret fill paths ride
  the same extension `type` command, and a digest of a typed password is crackable material.
- Unknown-key stripping is **denied on security-critical methods**
  (`STRICT_NO_STRIP_METHODS` in `browser-rpc-server-support.ts`): grants, credential/secret
  fill, fill plans, upload/download, manual-step/login, checkpoints. Discovered via the
  existing checkpoint-secrets security test; a silently dropped field there could weaken a
  caller-intended constraint or silently discard persisted data.
- The mutation guard checks **channel freshness before the pre-write scan** (integration test
  caught the inverted order: scanning a dead channel gives a slow misleading timeout instead
  of the honest `browser_extension_unreachable`).
- Suspension is lifted by the **bridge contact transition** (`recordExtensionContact` on a
  non-active→active edge calls `tabStore.restoreNode`), not by inventory re-attach inference;
  re-attach of a suspended target also clears it (either path emits `attachment_restored`).
- Implementation modules ended up as: `browser-rpc-contract.ts` (version + surface hash,
  dependency-free), `browser-rpc-server-support.ts` (validation + strip + report handler),
  `browser-tool-reveal-store.ts`, `browser-reliability-events.ts`,
  `browser-target-persistence-sentinel.ts`, `browser-app-write-guard.ts` (guard sequencing,
  split out for the LOC ratchet), `browser-write-journal.ts`,
  `browser-assert-persisted-operation.ts`, `browser-reliability-operations.ts` (service
  delegates). LOC allowlist: service ceiling 2475→2530; the two declarative catalogs
  (`browser-mcp-tools.ts`, `browser.schemas.ts`) allowlisted at current size.
