# Bigchange: Robust Browser User (2026-07-06)

Goal (James): a browser user robust enough that Harness can fill forms, post on his
behalf, do research, and — above all — **fully release iOS and Android apps**:
image uploads, build uploads, and the whole console workflow.

Status: LOCALLY IMPLEMENTED 2026-07-07 — uncommitted, but NOT OPERATIONALLY
COMPLETE. Code/tests are in the worktree; deployment still requires the physical
rollout steps called out below (worker redeploys, extension reloads, Harness
restart where applicable) plus real release evidence. Do not commit.

## Framing decision: route by strength, API-first

"Release an app through the browser" is the wrong literal target. The robust
architecture routes each step to its strongest channel:

| Step | Channel | Why |
|---|---|---|
| iOS build upload | `xcrun altool` + ASC API key | Already proven (see `~/work/mobile-app-release-gotchas.md`); browser upload of builds isn't even offered by ASC |
| iOS export compliance, TestFlight group attach, metadata, screenshots, submit | **ASC API** | Full API coverage; scriptable, verifiable, no approval dances |
| Android AAB upload, tracks, listings, store images | **Play Developer Publishing API** | Multi-hundred-MB browser uploads are the least robust path we have; API is atomic + verifiable |
| Play data safety form, content rating questionnaire, declarations | **Browser user** | No API. This is the genuinely browser-only part of a release |
| Ad-hoc forms, posting on James's behalf, research on logged-in sites | **Browser user** | The real logged-in session is the whole point |

### Corrected scope: the browser-only surface is large (verified 2026-07-06)

The **recurring per-release loop** is API-covered. The **per-new-app setup
gauntlet** is mostly console-only — and because our apps are white-label
multi-brand, "one-time setup" recurs with every new brand. Browser automation of
these flows is therefore FIRST-CLASS, not fallback:

Google Play — console only (no API):
- Creating the app record itself (androidpublisher has no create-app endpoint)
- Content rating (IARC) questionnaire
- Data safety form (a CSV import exists, but it is imported via the console UI —
  still valuable: generate the CSV, then a short browser flow instead of ~50 clicks)
- App content declarations: target audience & content, ads, app access (review
  login credentials), news, financial features, health, government, advertising
  ID, sensitive-permission declarations (SMS/call-log, accessibility, all-files,
  VPN, exact alarms)
- Account-level: developer identity verification, payments profile, tax
- Policy appeals / rejection responses; store listing experiments;
  pre-registration; Play Games services setup

Apple — not in the official ASC API:
- Creating the app record (fastlane `produce` still uses the private
  cookie-session API, fragile under 2FA — the real logged-in browser session may
  actually be the MORE robust channel here)
- Agreements, tax, banking; account-holder verification
- App privacy "nutrition labels" (fastlane's uploader relies on undocumented
  endpoints; treat as browser/console work)
- Resolution Center: review replies, appeals, rejection handling
- Promo codes, featuring nominations
- (Age rating IS API-covered — `ageRatingDeclarations` — a welcome exception)

API-covered per-release loop (keep API-first): iOS build upload + processing
poll + export compliance + TestFlight groups/testers + metadata + screenshots +
submit + phased release; Play AAB upload + tracks + staged rollout + listings +
store images + IAP/subscriptions.

Credentials needed (check `/Users/suas/work/creds` + Bitwarden; never in repo):
ASC API key (.p8 + key id + issuer id), Play service-account JSON with publishing
access. Missing ones → ask James to create, store in Bitwarden.

## What exists today (verified 2026-07-06)

- Extension relay chain: extension (MV3 `resources/browser-extension/background.js`)
  → native host → worker relay (`src/worker-agent/worker-extension-relay.ts`)
  → coordinator RPC → `BrowserExtensionCommandStore` (30s default command timeout).
- Extension already has: 1-min `chrome.alarms` inventory+poll restart, poll
  watchdog, native-port reconnect, buffered non-poll messages.
- Worker relay tracks `lastExtensionContactAt` + logs contact lost/resumed —
  but **nothing consults this when a command times out**.
- `list_targets` serves cached inventory; refresh failures are swallowed
  (`browser-extension-inventory-refresh.ts` `.catch(() => undefined)`) → "I can
  see your tabs" while the command channel is dead. Misleading.
- Remote upload staging exists (`browser-remote-upload-staging.ts`, stages into
  node `_scratch/aio-browser-uploads`); large multi-MB uploads historically flaky.
- Wedge detection + auto-reload exists for puppeteer-managed targets
  (`browser-wedge-recovery.ts`); extension tabs get anti-throttle but screenshot
  via CDP attach can crash the renderer (known issue, gotchas doc).
- Known symptom explained: worst-case extension recovery gap (SW suspended /
  native host died) is ~60s+ (alarm period), but commands give up at 30s → the
  `browser_extension_command_timeout` twice-then-fine pattern.

## Phase 1 — Channel truthfulness & liveness (small, high leverage)

**STATUS: IMPLEMENTED 2026-07-07** (uncommitted). All items below landed, plus a
discovered fix: the worker relay's poll-forward RPC timeout was a flat 15s that
could abandon a long-poll the coordinator was still holding — a command handed
over at that moment was silently dropped (plausible under coordinator load).
Now poll-window + 10s headroom. Key design: the command store distinguishes
"not delivered" (removed from queue before rejecting ⇒ provably never ran ⇒
retry-safe, even mutations) from "delivered but unanswered" (maybe applied).
Undelivered commands wait out one extension recovery cycle (90s) instead of
dying at 30s. Verified: tsc + spec-tsc clean, ng lint clean, 336 browser-gateway
tests + relay spec green, aio-mcp SEA rebuilt. Worker relay change needs the
worker redeployed to nodes. ts-max-loc violation in settings-handlers.ts is a
DIFFERENT in-flight workstream's uncommitted code, not this change.

1. **Honest timeout errors.** When a node-queued command times out, enrich the
   error with extension contact state: e.g.
   `browser_extension_channel_down (windows-pc: last extension contact 3m12s ago)`
   vs `browser_extension_command_timeout (channel active — command not answered)`.
   Contact state must flow from worker relay summary → coordinator (it's already
   in the node summary) → command store rejection path.
2. **Stale-marking in `list_targets`.** If the per-node refresh command failed,
   mark that node's targets `stale: true` + `lastConfirmedAt`. Agents stop
   treating cached tab lists as proof of life.
3. **Close the 30s/60s gap.** Raise the *queue-wait* portion of the timeout for
   idempotent commands (`open_tab`, `navigate`, `report_inventory`, snapshots)
   to ≥ 90s so a single alarm-cycle recovery still succeeds. Keep execution
   timeout as-is. Non-idempotent commands (click/type/fill) keep a short queue
   wait + fail fast with the honest error from (1).
4. **Pre-flight in `browser_health` / `find_or_open`.** Report per-node channel
   state (last poll age, queue depth) so a workflow can check before starting a
   90-minute release session.
5. **Telemetry.** Count SW restarts, poll gaps > 30s, native-host disconnect
   reasons — so Phase 1 tuning is data-driven, not guesswork.

Bridge note: browser-gateway MCP bridge ships in the aio-mcp SEA — changes need
`build:aio-mcp-dist`, not just a main rebuild. Windows worker changes need the
worker redeployed to the nodes.

## Phase 2 — Verified mutations (make single actions trustworthy)

**STATUS: CHANNEL-ROBUSTNESS SLICE IMPLEMENTED 2026-07-07** (uncommitted):
- **Receipt ack (delivered ≠ received):** extension acks `command_received`
  before executing; store enforces a 15s receipt window ONLY on queues that
  have proven receipt support (self-calibrating, no version negotiation; a
  queue rejection resets capability for reconnects). Missing receipt →
  `browser_extension_command_receipt_missing` ("almost certainly did not run,
  verify before retrying a mutation") — shrinks `maybe_applied` to the
  genuinely ambiguous case.
- **Result re-send until acked:** worker relay retries command results
  3s/6s/12s/24s instead of one fire-and-forget retry; coordinator
  resolveCommand is idempotent so re-sends are duplicate-safe.
- **Full timeout ladder fixed end-to-end:** coordinator holds ≤10s → relay
  waits poll+10s → native host waits poll+15s → extension watchdog 30s.
  Previously the native host (15s flat) and extension watchdog (15s) could
  abandon a reply carrying a freshly dequeued command.
- **Disconnect telemetry:** native host reports `extension_disconnected` on
  stdin EOF → relay → coordinator contact state (lastDisconnect + reason),
  surfaced in health and channel error summaries. Freshness semantics
  unchanged by design.
- **Extension recovery alarm 60s → 30s** (MV3 minimum), halving the
  worst-case poll-restart gap. Extension bumped to 0.2.0.
- **Post-timeout recovery probes:** a timed-out `open_tab` triggers an
  inventory refresh + re-match and returns SUCCESS when the tab actually
  opened; a timed-out mutation appends a fresh-url/title snapshot probe to the
  maybe_applied error so callers can usually self-resolve applied-vs-not.
- `browser-gateway-refresh-support.ts` extracted to keep the service under its
  size ratchet.
Verified: tsc (main+spec+worker), ng lint, ts-max-loc, 181 tests across the 10
touched suites, aio-mcp SEA rebuilt (native host + rpc client ship in it).
Deploy needs: worker redeploy to nodes (relay), extension reload on all
machines (0.2.0), Harness restart on the mac.

**STATUS UPDATE 2026-07-07: PHASE 2 COMPLETE** (uncommitted):
- Read-back verify contracts are wired into `click`, `type`, `select`, and
  `fill_form` for managed profiles and shared existing tabs. The `verify`
  contract re-reads the control and fails loudly on mismatch.
- Upload verification now checks host↔node transfer integrity with size +
  SHA-256, then verifies the page's selected file state after upload without
  leaking local or remote paths.
- The screenshot item is resolved by the existing CDP `Page.captureScreenshot`
  implementation, not by `captureVisibleTab`. This is intentional: the
  extension regression suite asserts `captureVisibleTab` is absent because the
  known issue was fixed by tab-targeted DevTools capture.

1. **Timed-out-but-applied detection.** On mutation timeout, auto-read the
   target (snapshot/query) and report `timed_out_applied` vs
   `timed_out_not_applied` vs `unknown`. This is the #1 enabler for form flows —
   today a timeout on "Save" forces a human to look.
2. **Safe screenshots on extension tabs.** Replace/augment CDP-attach capture
   with `chrome.tabs.captureVisibleTab` (no debugger collision, no
   `RESULT_CODE_KILLED_BAD_MESSAGE`). Routine visual verification becomes safe,
   which everything else leans on.
3. **Upload verification.** After staging: hash check host↔node (file-transfer
   service). After the page upload: read back the page state (file listed,
   thumbnail rendered) before reporting success. Surface site-specific recovery
   hints (e.g. Play "Add from library").
4. **Read-back contracts on `fill_form`/`select`/`click`** — optional
   `verify` option that re-queries the control and fails loudly on mismatch
   (query_elements already reports current values; wire it in).

## Phase 3 — Workflow durability (multi-step flows that survive)

**STATUS: IMPLEMENTED 2026-07-07** (uncommitted):
- Checkpointed browser workflow conventions are codified in the built-in
  `new-app-setup` release skill, including resume/re-verify behavior.
- Grant persistence is node-aware: grants can persist by `nodeId` + origin for
  existing-tab sessions, with an RLM migration for `browser_permission_grants`.
- Plan-scoped approval mechanics are available through browser campaign leases
  (`browser.claim_campaign_lease`) and existing campaign runtime enforcement.
- Mobile approval push plumbing was already part of the platform; this change
  keeps long browser flows compatible with that approval path rather than
  replacing it.

1. **Checkpointed browser workflows.** A runner/skill convention that records
   each completed step + a page-state fingerprint; resume re-verifies completed
   steps instead of redoing them. Must re-acquire profile/target ids (they churn
   on crash/reconnect) and re-request grants.
2. **Grant persistence.** Map grants to (nodeId, origin) rather than ephemeral
   profileId so reconnects don't strand a mid-flow session.
3. **Plan-scoped approvals.** Approve a declared workflow once ("complete Play
   data safety form for <app>") → submit-class actions within (node, origin,
   time-box) auto-approved; destructive still per-action. Today's
   requestId-retry dance stalls long flows for hours.
4. **Push approvals to the mobile control app** (APNs already implemented) so
   James can unblock a flow from his phone.

## Phase 4 — Release workflow skills (the actual goal)

**STATUS: IMPLEMENTED 2026-07-07** (uncommitted):
- Added built-in `ios-release`, `android-release`, and `new-app-setup` skills
  with regression coverage.
- Folded the mobile release gotchas into executable skill steps: iOS
  `CURRENT_PROJECT_VERSION`, SPM/project archive path, `xcrun altool`, ASC API
  processing/export compliance/TestFlight group attachment; Android
  `versionCode`, upload keystore properties, `bundleRelease`, Play Developer
  Publishing API, `Add from library`, and `assetlinks.json` SHA capture.
- Browser-only console work is first-class through `new-app-setup`, with
  checkpointing, session checks, verified mutations, campaign leases, and
  escalation gates for account/legal/identity prompts.

1. **`ios-release` skill:** version bump → archive/export → altool upload →
   poll ASC processing → set export compliance → attach latest build to
   TestFlight internal group → (optional) submit. All API/CLI. Browser only for
   unexpected account-level prompts (agreements, tax forms).
2. **`android-release` skill:** version bump → bundleRelease → Play API upload
   to track → rollout. Listings/images via API. Browser sub-flow for content
   rating questionnaire + data safety form (checkpointed per Phase 3).
2b. **`new-app-setup` browser skills (first-class, per new brand):**
   - Play: create app record → full App content declarations suite → content
     rating questionnaire → data safety (generate CSV offline, import via
     console) → app access credentials. Each sub-form is a checkpointed,
     verify-after-every-save browser flow.
   - ASC: create app record via the real logged-in session (more robust than
     fastlane's private-API `produce` under 2FA) → privacy nutrition labels →
     agreements/tax prompts surfaced to James rather than auto-answered.
   - Resolution Center / policy-appeal reader: browser flow that extracts
     rejection details into the session so the agent can draft the fix + reply.
3. **Store asset pipeline:** generate/resize screenshots + icon 512 + feature
   graphic 1024×500, incl. 7"/10" tablet sets; stage to whichever machine
   uploads. (Screenshot capture via ios-testing / android-adb-testing skills.)
4. Fold `~/work/mobile-app-release-gotchas.md` into the skills as executable
   steps with verify gates, not prose.

## Priority order

1. Phase 1 (days, unblocks trust; everything else builds on honest signals)
2. Phase 2.1 + 2.2 (verified mutations + safe screenshots)
3. Phase 4.1/4.2 API-first release skills — can run in PARALLEL with 2/3, it's
   mostly non-browser work and delivers the headline goal fastest
4. Phase 3 durability, then remaining Phase 2/4 items

## Verification bar per phase

- Unit: vitest on command store timeout paths, stale marking, verify contracts.
- Integration: kill the native host on a test node mid-flow → assert honest
  error + recovery inside one alarm cycle; pull network → resume a checkpointed
  flow.
- End-to-end: release a real build of one brand's app to TestFlight internal +
  Play internal testing with zero manual console clicks except gated approvals.

## Addendum 2026-07-07: windows-pc live incident — root causes + hardening (all coded, uncommitted)

Live diagnosis found the real outage anatomy: (1) Chrome's native-host manifest pointed
at the Harness desktop app's install whose named pipe no longer existed (worker relay
refused to repair it for days, WARNing once a minute); (2) the extension's MV3 service
worker wedged in-memory while its open native port made it immortal — no restart, no
polls, alarms firing into the wedged worker forever. Remote remediation applied to the
node (manifest repointed at relay install, backup kept; wedged hosts bounced). Coded so
neither recurs:

- Dead-owner manifest takeover: `inspectForeignBrowserExtensionNativeHost` proves a
  foreign install dead (wrapper/runtime/socket chain) before the legacy installer takes
  it over; live foreign installs still win; refusal warnings dedupe via caller-owned set.
- Extension self-heal ladder (`selfHealIfWedged`, alarm-driven): no healthy poll ack for
  5m → hard bridge recycle; still dead at 10m → `chrome.runtime.reload()` rate-limited
  to 1/30m via storage. The only true reset for unforeseen wedge states.
- Relay contact-lost WARN verified already coded + heartbeat-driven (deploy-gated only).

Gates: tsc main+spec clean, 829 tests green (browser-gateway + worker-agent), lint 0
errors, SEA rebuilt, extension 0.2.1. Remaining steps are physical: commit/deploy worker
to nodes, reload extension, run the kill-the-native-host drill.

## Addendum 2026-07-07: release API MCP surface + store asset manifest pipeline

Follow-up audit found one remaining code gap: ASC/Play API clients existed, but the
agent-facing orchestrator MCP surface did not expose concrete release tools in the
SEA forwarder. Fixed, uncommitted:

- Added `build_ios_release_plan`, `build_android_release_plan`,
  `build_new_app_setup_plan`, `execute_android_play_release`, and
  `execute_ios_asc_finalization` to the orchestrator-tools MCP/RPC path.
- Added `build_release_operational_readiness_report`, a non-mutating readiness
  gate that blocks completion until there is evidence for worker redeploys,
  extension reloads, Harness restart, browser health, native-host recovery drill,
  TestFlight internal release, and Play internal release.
- The execution tools read ASC/Play credential files locally and do not return key
  material or service-account secrets.
- The SEA forwarder now shares the parent release-tool JSON schemas instead of
  exposing loose `{ additionalProperties: true }` schemas.
- Public store submissions now include a structured store asset manifest pipeline:
  prepare assets, verify dimensions/counts/hashes, then upload via ASC/Play API.
  Production Play plans block without app icon 512, feature graphic 1024x500,
  phone screenshots, and 7"/10" tablet screenshot sets. App Store submit plans
  block without iPhone/iPad screenshot manifests.
- Verified with targeted release/browser MCP specs, the full quiet suite
  (1190 files / 11829 tests), typechecks, lint, architecture, exports/contracts
  checks, dead-export sweep, `build:aio-mcp-dist`, and `npm run build`; probed
  the rebuilt SEA to confirm release tools, the readiness gate, and asset
  schemas are visible.

Still not operationally complete until the physical rollout happens: worker
redeploys, extension reloads, Harness restart where needed, native-host kill/recovery
drill, and at least one real TestFlight internal + Play internal release run.

## Addendum 2026-07-07: rollout evidence plumbing completed locally

Follow-up audit found the readiness gate could require evidence but did not yet
surface enough non-secret rollout evidence from `list_remote_nodes` to collect it
cleanly. Fixed, uncommitted:

- Worker heartbeats now advertise `workerAgent.version` and `workerAgent.startedAt`
  from the rebuilt worker bundle.
- Extension native-port messages now include `extensionVersion` and
  `extensionStartedAt`; the native host forwards that to the worker relay, and
  the relay summarizes it as `extensionVersion` / `extensionReloadedAt`.
- `list_remote_nodes` now exposes `workerAgent`, `hasExtensionRelay`, and
  `extensionRelay` rollout fields, so an agent can inspect which machines have
  the rebuilt worker and freshly reloaded extension.
- `build_release_operational_readiness_report` now accepts that
  `list_remote_nodes` shape directly and normalizes it into the stricter release
  readiness evidence model.

Verified: targeted rollout-evidence specs (108 tests), adjacent MCP forwarding
specs (100 tests), `npx tsc --noEmit`, Electron tsc, spec tsc, lint,
`check:ts-max-loc`, `build:worker-dist`, `build:aio-mcp-dist`, full quiet suite
(1190 files / 11836 tests; first full run hit a non-reproducible ACP stall-warning
flake, rerun passed), and `npm run build` (passes with the existing Angular
initial-bundle budget warning).

Still not fully implemented in the operational sense: no live worker redeploys,
extension reloads, Harness restart proof, browser health/list_targets proof,
native-host kill/recovery drill, TestFlight internal release, or Play internal
release evidence has been captured in this local session.

## Addendum 2026-07-07: release-readiness CLI for captured rollout evidence

Continuation audit confirmed this shell has no live parent orchestrator-tools RPC
socket (`aio-mcp remote-nodes --json` reports parent socket/instance id missing),
so it cannot query live workers or perform the physical rollout from here. Added
one more local bridge for the real rollout:

- `aio-mcp release-readiness --evidence <path> [--json]` now builds the same
  operational readiness report from a captured evidence JSON file.
- `aio-mcp release-readiness --capture-remote-nodes [--evidence <path>] [--json]`
  now calls the parent `list_remote_nodes` RPC when run from a live Harness
  instance, so worker redeploy + extension reload evidence can be captured from
  the running roster instead of copied by hand.
- `aio-mcp release-readiness --capture-browser-health [--evidence <path>] [--json]`
  now calls Browser Gateway `browser.health` and refreshed `browser.list_targets`
  when a browser gateway RPC socket is available. This fills the
  browser-health/list_targets readiness gate from live evidence.
- `aio-mcp release-readiness --write-evidence <path>` now writes the merged,
  validated readiness evidence JSON after applying captures and expected-version
  overrides. This supports iterative rollout: capture worker/browser evidence
  from live Harness, then append native-host/store-release evidence later and
  re-run the same file.
- The same CLI can now record the remaining operator-confirmed release gates
  without hand-editing JSON: `--harness-restarted-at`, native-host recovery
  drill flags, TestFlight internal release flags, and Play internal release
  flags merge into the evidence file before validation/write-back.
- The CLI accepts the same `list_remote_nodes`-shaped `remoteNodes` data as the
  MCP readiness tool, normalizes it through the shared mapper, and prints either
  JSON or a concise blocked/ready report with next actions.
- Blocked browser-health checks now preserve captured evidence (`checkedAt`,
  `ok`, and summary) so an operator can see whether the gate failed because the
  browser gateway was absent, missing, stale, or otherwise unhealthy.
- The subcommand is wired into the SEA dispatcher and rebuilt into
  `dist/aio-mcp-cli-sea/aio-mcp`.

Verified: focused release/readiness + dispatcher/CLI specs (21 tests),
main/Electron/spec tsc, lint, `check:ts-max-loc`, `build:aio-mcp-dist`, built
CLI probe with synthetic remote/browser/manual evidence + evidence write-back,
full quiet suite (1191 files / 11849 tests), and `npm run build` (passes with
the existing Angular initial-bundle budget warning).

Operational blockers remain unchanged: redeploy workers, reload extensions,
restart Harness where needed, capture browser health/list_targets evidence, run
the native-host recovery drill, and complete real TestFlight internal + Play
internal releases.

## Completion re-audit 2026-07-10

The local implementation remains complete, but the bigchange is not ready for an
`_completed` rename because the operational release gate is still blocked.

The 2026-07-10 code and security re-audit found no additional local browser
implementation gap; the blockers below remain external rollout evidence.

The refreshed `_scratch/release-readiness-evidence.json` now proves four of the
seven readiness checks:

- Harness restart evidence: passed.
- Browser Gateway health plus refreshed target inventory: passed.
- Worker redeploy: passed. The live Windows worker matched the staged deployment
  artifact at transfer time and reports a fresh worker start and coordinator
  connection after deployment.
- Extension reload: passed. The Windows relay reports extension 0.2.1, a fresh
  reload timestamp, and healthy post-reload contact.

The same report still blocks three checks, with newer live evidence narrowing the
mobile items:

- Native-host kill/recovery drill: no operator-confirmed result is present.
- TestFlight internal release: 12 Step Companion build 13 is valid and attached
  to Internal Testers, but build-13 device smoke is not recorded.
- Play internal release: version code 12 is committed, fully rolled out to the
  internal track, available to the 20-account tester list, and has an opt-in
  link, but no Play-installed device smoke is recorded.

The real mobile target is now identified as 12 Step Companion. App Store Connect
and Play Console release state are therefore evidenced rather than hypothetical.
The remaining mobile gaps are device smoke: the paired iPhone is currently
offline to Xcode and has an older TestFlight build installed. The Google Play
emulator accepted the internal tester's password but is waiting for the
account's Google two-step approval before it can opt in and prove a Play-origin
install.

The connected Windows worker now runs the rebuilt bundle, and its extension
relay is healthy after reload. Do not rename this file `_completed` until the
native-host recovery drill and both device smokes pass.

## Closure (2026-07-10)

Closed by James as implemented. The local browser-resilience implementation is
complete and green. The native-host kill/recovery drill was executed live on
windows-pc 2026-07-10: killing the relay native host, then BOTH native hosts with
both manifests renamed away, drove registration ok -> "repaired" with self-recreated
manifests (+ .bak-harness backup and native-host-error.log) and clean channel
recovery within ~9s; no mutation ever falsely reported "applied"; chrome.exe and
the worker agent were never touched.

DEFERRED, not performed: (1) capturing the literal browser_extension_channel_down
string during a sustained outage — the self-heal/manifest-takeover repaired the
channel faster than a queued command could time out; (2) the TestFlight and Play
internal device smokes (12 Step Companion) — need the paired iPhone online to Xcode
and the Play account past Google two-step. Rename records implementation + verified
recovery behavior, not the two device smokes.
