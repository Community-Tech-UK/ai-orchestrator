# Prompt: make the AIO browser-gateway survive long, stateful automations

Paste this to a coding agent working in `~/work/orchestrat0r/ai-orchestrator`. It is a
brief, not a patch — investigate before changing anything.

---

You are hardening the **AIO browser-gateway** (the `mcp__browser-gateway__*` tools) so a
remote agent can reliably drive a long, multi-step form flow in a shared, logged-in
browser tab on a remote worker node (a Windows PC) without silently losing work when the
channel blips.

## Read before you write

- Read `~/work/aio-remote-browser-gotchas.md` in full — it documents the hardening
  already shipped (anti-throttle, wedged-renderer detection, channel-error semantics,
  grants, per-action approval). **Do not regress any of it.** Your job is the next layer.
- Then map the actual code. Likely locations (verify, don't trust):
  - Extension driver: `resources/browser-extension/background.js`
  - Gateway RPC / call layer: `openclaw/src/gateway/` (see `call.test.ts`)
  - Worker build/entry: `tsconfig.worker.json` and its referenced entrypoint
  - MCP tool registration: grep the repo for the tool names (`find_or_open`,
    `list_targets`, `evaluate`, `snapshot`, `checkpoint_save`) to find where the
    `mcp__browser-gateway__*` surface is defined and where each maps to a worker RPC
  - Shared types: `src/shared/types/settings.types.ts`
  - Browser feature UI: `src/renderer/app/features/browser/*`
- State your findings and a plan (what changes, why, what could break, which tests cover
  it) before editing.

## The system, as observed

`Claude session ──MCP──> browser-gateway server ──> worker node ("windows-pc")
──> Chrome extension (driver:"extension") ──CDP──> the user's real, logged-in tab`.

`profileId`/`targetId`/`pageId` are per-shared-tab and can change on any crash / node
reconnect. Grants are per-profile.

## Failure modes observed (real session: publishing a Google Ads Search campaign)

Driving Google Ads' multi-step "new campaign" wizard end to end, the following happened
**three times across the session**, each tied to a channel blip:

1. **Silent target-app write loss.** Mid-flow the Google Ads SPA showed **"You got
   disconnected"**, then a persistent **"Changes failed to save"** indicator. The
   gateway kept returning `succeeded` for `browser_click` / `browser_type`, and a DOM
   read-back looked fine — but the wizard's own XHR saves had been rejected. On
   reloading the draft (Campaigns → Drafts → Finish), the **keywords, the responsive
   search ad, and the budget were empty** (bidding + campaign settings had survived).
   Net effect: ~an hour of entry silently rolled back, twice, with no error surfaced.

2. **Full worker-node drop.** At one point the `browser-gateway` MCP server disconnected
   entirely — `list_targets` returned `[]` and only the `"local"` computer remained; the
   `windows-pc` node vanished, then reappeared minutes later. Nothing distinguished
   "reconnecting" from "dead" (this part is already noted in the gotchas doc under
   Infra/availability, but the recovery UX is poor).

3. **Tool-capability churn across reconnect.** After the node came back, the MCP tool set
   exposed to the client was **not identical to before**: `browser_evaluate` was gone
   (a `select:` search for it returned "no matching deferred tools"), while
   `browser_snapshot`, `browser_navigate`, `browser_list_targets` were present. Losing
   `evaluate` mid-task removed the only reliable way to tag/locate deeply-nested form
   fields, forcing a much more fragile approach.

4. **RPC schema mismatch.** `browser_snapshot { extractionHint: "…" }` returned
   `invalid_browser_gateway_rpc_payload`. An optional field the MCP wrapper advertises
   hard-failed at the worker instead of degrading — i.e. host and worker are schema-skewed.

## Root-cause hypotheses (confirm each against the code)

- **(1)** On extension re-attach after a blip, the target tab's in-page session
  (auth cookie / CSRF / XHR credentials) is invalidated by the SPA, but the gateway has
  no notion of "the app rejected this write." Success is reported at the CDP-dispatch
  level (the click fired) with no post-write persistence check.
- **(2)** Reconnect/backoff has no heartbeat-driven fast path and no clear
  "degraded vs down" signal to the client.
- **(3)** The MCP tool surface is (re)built from live worker capability at connect time,
  so a partial/slow reconnect advertises a partial tool set. There is no stable, declared
  capability contract.
- **(4)** RPC payloads aren't version-negotiated; unknown/newer optional fields throw
  instead of being ignored or handled by an older worker.

## Requirements (acceptance criteria)

1. **Surface target-app persistence failures — never report a silently-dropped write as
   success.** Add detection for the app's own failure signals (e.g. an "unsaved changes /
   changes failed to save / you got disconnected / session expired" heuristic, with an
   optional per-site adapter hook) and return a distinct error such as
   `browser_target_session_stale`. At minimum, provide a first-class **assert-persisted**
   primitive callers can use after a mutation, and make long flows fail loud, not quiet.
2. **Capability parity across reconnect.** The tool set exposed to the client must be
   **identical before and after** a worker reconnect. No tool (especially
   `browser_evaluate`) may silently disappear. If a capability is genuinely unavailable,
   expose it as present-but-erroring with a clear reason, not missing.
3. **Versioned, forward-compatible RPC.** Host↔worker must negotiate a schema/version.
   Unknown optional fields (like `extractionHint`) must degrade gracefully; never return
   `invalid_browser_gateway_rpc_payload` for an additive optional field.
4. **Session continuity + staleness detection.** After the extension re-attaches, verify
   the target tab's session is still valid before allowing writes; if it's stale, refuse
   the write and tell the caller to re-acquire, rather than firing into a dead session.
5. **Heartbeat + transparent auto-reconnect.** Keepalive so short blips don't tear the
   channel down; on a real drop, reconnect restores `profileId`/`targetId`/grants and
   re-selects the same shared tab, and reports the id changes to the caller.
6. **Durable, resumable multi-step flows.** Either wire up the existing
   `browser_checkpoint_save/resume` to a real write-journal, or add one: record each
   intended mutation + a persistence verification, so an interrupted flow can report
   exactly what persisted and be resumed instead of half-applied.
7. **Predictive `browser_health`.** Pre-flight before a long flow and after any
   reconnect: contact age, queue depth, **schema-version match**, and **tool parity**.
   A green health check should mean "safe to start a 50-step flow."
8. **Observability.** Structured logs/metrics for: disconnects (with reason), dropped/
   rejected writes, tool-registration diffs across reconnect, and schema-mismatch events.

## Repro / test to build

Automate (or script as an integration test) a **multi-step SPA form flow** — the Google
Ads new-campaign wizard is the canonical case, but any SPA with per-step XHR saves works.
Mid-flow, **force a worker reconnect** (kill/restart the node channel). Assert:

- (a) the exposed tool set is unchanged after reconnect;
- (b) any write issued into the stale session is returned as an **error**, not `succeeded`;
- (c) the flow can be resumed, or at minimum accurately reports which steps persisted;
- (d) `browser_snapshot { extractionHint }` and other additive optional fields never
  hard-fail on version skew.

## Constraints / non-goals

- Preserve every behaviour in `~/work/aio-remote-browser-gotchas.md` (anti-throttle,
  wedged-renderer reload, single-issue no-blind-retry, channel-error taxonomy,
  grant/approval flow). Extend that doc with whatever you add.
- Security: shared, logged-in tabs. Never log cookies/tokens/session values. Reconnect
  must not leak or cross-wire sessions between profiles.
- Don't paper over (1) with blind retries of non-idempotent writes — detection +
  surfaced error is the goal, not silent re-firing.

## Deliverables

- Code changes with tests (unit for the RPC/versioning + capability-parity logic;
  one integration test for the reconnect-mid-flow repro above).
- Updated `~/work/aio-remote-browser-gotchas.md` with the new error codes / health
  fields / assert-persisted primitive.
- A short "what changed and how to verify" note.
