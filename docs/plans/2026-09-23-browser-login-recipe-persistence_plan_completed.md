# Browser login recipe persistence and post-sign-in readability

Status: completed 2026-09-23 (code items 1-3 implemented and verified; item 4 live test deferred to [the livetest doc](2026-09-23-browser-login-recipe-persistence_livetest.md))

**2026-09-24 follow-up:** The live test's Check 3 failed against extension 0.2.34 and was filed
as LT-617; Checks 1 and 2 remain unrun. The LT-617 command-store fix and extension 0.2.35 are
committed at `39d245ba`. This is code-fixed, not live-verified: Check 3 still needs a rerun after
0.2.35 reaches `windows-pc`. The 0.2.34 references below describe the original implementation
and test run, not the version required for that rerun.
Source prompt: `~/work/orchestrat0r/ai-orchestrator-plans/2026-09-23-browser-portal-login-lockout_prompt.md`
Base: `46cd2aa0` on the current checkout. No branch or worktree.

## Goal

An agent signs in to a supplier portal on windows-pc Chrome and then reads it, with no manual
step from James. The test case is In-tend (Publica Group), tender WODC0653P, Correspondence page.

## Findings (verified against code on 2026-09-23)

1. `LoginFingerprintStore` (`src/main/browser-gateway/browser-session-relogin.ts:53-87`) is an
   in-memory Map inside a module singleton, keyed `${profileId}::${origin}`. A restart loses every
   recipe. A shared tab's profileId is `existing-tab:n.<node>:<window>:<tab>`, so a recipe stored
   for one tab is invisible to the next tab.
2. Credential authorizations already key shared tabs by node scope through
   `credentialAuthorizationProfileScope` (`browser-gateway-service.ts:2473-2475`), which wraps
   `existingTabGrantNodeId` (`browser-grant-scope.ts:3-12`). That resolver is private to the
   service today.
3. `checkSessionOperation` treats a post-relogin `unknown` evaluation as success
   (`browser-session-relogin.ts:175`). `unknown` is what a failed or opaque snapshot produces, so a
   blocked read after sign-in is reported as `reloggedIn: true`.
4. The existing-tab snapshot probes the extension with a 1 s timeout when cached text exists and
   falls back to the cached copy, summary "Read cached snapshot"
   (`browser-existing-tab-operations.ts:420-425`, `:490-518`). check_session can therefore judge the
   session from stale text.
5. The protection stamp is applied only at some send sites (`browser-existing-tab-operations.ts:313`,
   `browser-gateway-service.ts:1325`). `open_tab` (`browser-target-discovery-operations.ts:495`),
   the list_targets inventory refresh (`browser-extension-inventory-refresh.ts:34`) and the
   post-timeout mutation probe (`browser-existing-tab-operations.ts:362`) send unstamped commands.
   The extension only clears taints when a stamped command arrives
   (`resources/browser-extension/background.js:1041-1047`).
6. Nothing reports the extension's protection state or taint count back to the coordinator, so
   `browser.health` cannot explain a blocked read.

## Work items

### 1. Persist recipes, keyed by stable scope
- Migration `065_browser_login_recipes`: table `browser_login_recipes`, primary key
  `(scope, origin)`, columns for scope kind, login URL, logged-in markers, relogin JSON (vault item
  reference and selectors only), timestamps and last check outcome.
- Move the scope resolver into `browser-grant-scope.ts` as `credentialScopeForProfile` and use it
  from both the credential fill path and the recipe store. No second scheme.
- `LoginFingerprintStore` becomes a thin service over a `LoginRecipeRecordStore`. The app singleton
  always uses the SQLite store; the in-memory record store exists for unit tests only.
- `remember_login_fingerprint` writes through; `check_session` resolves the scope and reads the row.
- New MCP tools `browser.list_login_recipes` and `browser.forget_login_recipe`, with the last
  check outcome so an agent can see why re-login did or did not fire.

### 2. Protection switch reaches every command, and health shows it
- Stamp the protection flag centrally in `BrowserExtensionCommandStore.sendCommand`, so every
  command on every queue (local and node) carries it. Remove the now redundant per-site stamps.
- Extension `report_inventory` result returns `secretObservation: { protectionEnabled,
  taintedOriginCount, taintedTabCount }`. The command store records it per queue on resolve.
- `browser.health` reports it per remote node and for the local extension, plus the coordinator
  setting and a warning when they disagree.
- Extension audit for stale taint paths; tests in `browser-secret-recovery.testutil.ts` style.
- `browserSecretObservationProtectionEnabled` is not touched by the agent.

### 3. check_session signs in and hands back a readable tab
- Snapshot request gains an internal `requireLive` flag (not on the MCP schema). check_session
  always uses it; a cached snapshot is never used to judge a session.
- Success requires `logged_in` from a live, readable snapshot. An opaque (secret-tainted) or
  unavailable page after sign-in is reported as such, not as success.
- After submit, poll the live page for a bounded settle window before judging.
- The outcome carries the live page title and URL.

### 4. Live test on windows-pc (read only)
Deferred: see [2026-09-23-browser-login-recipe-persistence_livetest.md](2026-09-23-browser-login-recipe-persistence_livetest.md).

## Verification
- Targeted specs for each file touched, then the canonical checklist in `AGENTS.md`.
- Fresh-eyes `task-completion-gate` review until `VERDICT: PASS`.

## As built
- `browser-login-recipe-store.ts`: `LoginFingerprintStore` over a `LoginRecipeRecordStore`;
  `SqliteLoginRecipeStore` in `browser-unattended-sqlite-stores.ts`; singleton
  `getBrowserLoginRecipeStore()` in `browser-unattended-services.ts` (SQLite only). Migration
  `065_browser_login_recipes`. Scope resolver `credentialScopeForProfile` in `browser-grant-scope.ts`,
  shared with the credential fill path.
- MCP tools `browser.list_login_recipes`, `browser.forget_login_recipe`; session tool schemas moved
  to `browser-mcp-session-tools.ts`, shared schema fragments to `browser-mcp-schema-props.ts`.
- Protection stamp in `browser-secret-observation-stamp.ts`, applied in
  `BrowserExtensionCommandStore.sendCommand`; per-site stamps removed. Extension 0.2.34 returns
  `secretObservation` counts from `report_inventory`; `SecretObservationTracker` records them;
  `browser.health` shows `secretObservationProtection` and `remoteExtensions.nodes[].secretObservation`
  with a mismatch warning (`browser-secret-observation-health.ts`).
- `check_session`: live-only snapshots (`requireLive`), opaque/failed page after sign-in is not
  success, settle polling (6 x 1.5 s), refused submit fails the attempt, outcome carries
  `recipeScope` and the live `page`, last outcome recorded on the recipe.
- Verification: targeted specs green; full suite 26,024 tests with 2 failures, both in files
  another session is editing (codex thread runtime, transcript jump rail); main typecheck, lint,
  build:renderer green; build:main green on HEAD plus these changes (the live tree is blocked by
  another session's uncommitted edit); check:ts-max-loc fails only on the pre-existing
  input-panel ceiling. Fresh-eyes task-completion-gate: VERDICT PASS.

## Progress log
- 2026-09-23: plan written, investigation complete.
- 2026-09-23: items 1-3 implemented. Extension bumped to 0.2.34. Extension audit found one
  real stale-state path: two overlapping `loadSecretObservationProtection` storage reads could
  resolve after an applied `false` and switch protection back ON in memory, so the next fill
  re-tainted the origin. Fixed with a single in-flight read that never overwrites an applied
  value; the regression test fails on the old code.
- 2026-09-23: targeted specs, lint, main typecheck, build:renderer green. build:main green on
  HEAD plus these changes only (the live tree is blocked by another session's uncommitted
  `instance-communication.ts`).
- Live checkout on 2026-09-23 before rebuild: the In-tend shared tab on windows-pc was already
  signed in (a BFI Correspondence page with Logout), so a relogin on that origin may not be
  exercised unless the portal session has expired by the time of the live test.
