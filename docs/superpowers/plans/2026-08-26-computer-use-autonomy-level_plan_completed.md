# Computer Use Autonomy Level — Implementation Plan

**Status:** COMPLETED (2026-08-26, second close). Reopened after the first close when an independent
bug hunt found six defects, including one that broke this plan's own global constraint. All six are
fixed, a second independent gate returned `VERDICT: PASS` with no findings, and real-app checks stay
deferred to
[2026-08-26-computer-use-autonomy-level_livetest.md](./2026-08-26-computer-use-autonomy-level_livetest.md)
— **not** claimed as verified. Real-app checks are deferred to
[2026-08-26-computer-use-autonomy-level_livetest.md](./2026-08-26-computer-use-autonomy-level_livetest.md)
and are **not** claimed as verified.

**Date:** 2026-08-26
**Spec:** [2026-08-26-computer-use-autonomy-level_spec_completed.md](../specs/2026-08-26-computer-use-autonomy-level_spec_completed.md)

**Goal:** Replace three unconditional Computer Use denials with one `computerUseAutonomyLevel`
setting, defaulting to `trusted`, and fix the over-broad app matching that denies innocent apps.

**Tech stack:** Electron main process, TypeScript, Zod 4, Angular 22 signals, Vitest.

## Global constraints

- `guarded` must reproduce today's behaviour exactly, so the change is revertible by setting.
- `computerUseAutonomyLevel` must stay unwritable by the agent settings surface.
- Typed text must remain redacted from the audit store.
- Do not commit unless James asks.

---

### Task 1: Setting, type and default

**Files:** `src/shared/types/desktop-gateway-settings.types.ts`,
`src/main/core/config/settings-control-policy.ts`,
`src/shared/types/settings-metadata-integrations.ts`

- [x] Add `ComputerUseAutonomyLevel = 'guarded' | 'trusted' | 'unrestricted'` and
      `computerUseAutonomyLevel` to `DesktopComputerUseSettings`, default `'trusted'`.
- [x] Register in `SETTINGS_TOOL_POLICY` as `readOnly()` with a Zod enum schema, and add the key to
      the human/GUI-only list at `settings-control-policy.ts:70-84`.
- [x] Add settings metadata (`type: 'select'`, category `mcp`) so it is reachable in the UI.

### Task 2: Tier the app policy and fix the over-broad matching

**Files:** `src/main/desktop-gateway/desktop-app-policy.ts` + new `.spec.ts`

- [x] Split the constant into `SELF_CONTROL_PATTERNS` (Harness only) and
      `GUARDED_ONLY_PATTERNS` / `GUARDED_ONLY_BUNDLE_IDS` (everything else).
- [x] Delete the bare `/\bsecurity\b/`, `/\bprivacy\b/`, `/credential/`, `/\bshell\b/` and
      `/\bstocks\b/` patterns; replace with specific, anchored forms that cannot match an arbitrary
      path segment. Keep the precise ones (`keychain`, `1password`, `securityagent`, …).
- [x] Match name-ish fields and `executablePath` separately: a path may match a *bundle-id or
      basename* rule, never a loose word rule.
- [x] `decideDesktopAppPolicy()` takes the level; self-control denial applies at `guarded` and
      `trusted`, guarded-only denials apply at `guarded` alone.
- [x] Preserve precedence: hard deny → configured denylist → configured allowlist → needs_approval.

### Task 3: Tier the hotkey policy

**Files:** `src/main/desktop-gateway/desktop-input-policy.ts`, its spec

- [x] Split `isDeniedHotkey` into a confirm-key rule (Enter/Return/Space) and a destructive rule.
- [x] Confirm keys denied only at `guarded`; destructive combos denied at `guarded` and `trusted`.

### Task 4: Tier the sensitive-action gate

**Files:** `src/main/desktop-gateway/desktop-input-controller.ts`, its spec

- [x] Gate the `request.sensitive || isSecretLikeInput(request)` denial and the `isDeniedHotkey`
      denial on the level.
- [x] Keep the audit rows; add the deciding level to their metadata.

### Task 5: Thread the level through the service

**Files:** `src/main/desktop-gateway/desktop-gateway-service.ts`, its spec

- [x] Read the setting where `decideDesktopAppPolicy` is called (`:649`) and where the input
      controller is constructed. Read per call, not cached, so a change takes effect without restart.

### Task 6: Renderer

**Files:** `src/renderer/app/features/settings/computer-use-settings-tab.component.ts`, its spec

- [x] Add the select with the three levels and a plain-language description of each.

### Task 7: Verification

- [x] Focused specs for every acceptance item in spec §5.
- [x] Canonical checklist: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`,
      `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run test:quiet`.
- [x] Independent completion gate until `VERDICT: PASS`.
- [x] Close the lifecycle; record any rebuilt-app checks in a `_livetest.md`.

---

## As-built

**A bug fixed along the way, independent of the policy change.** The old matcher joined
`appId + displayName + bundleId + executablePath` into one string and tested bare words against it,
including `security`, `privacy`, `credential`, `shell` and `stocks`. Any application installed under
a path containing one of those was denied as "built-in hard deny" with no way to allow it. Matching
is now per-field and excludes `executablePath` (the self-control guard still considers the path,
deliberately). Anchored patterns like `/^wallet$/` only became meaningful once fields were tested
separately — the first draft joined them and silently stopped denying Wallet at `guarded`, which
`desktop-app-policy.spec.ts` caught.

**Deviation from the plan:** Task 6 needed no template change. The Computer Use tab renders rows
from `SETTINGS_METADATA`, and `SettingRowComponent` already handles `type: 'select'` with `options`,
so adding the key to `COMPUTER_USE_SETTING_KEYS` was sufficient.

**Two tripwire tests had to be updated, by design.** `orchestrator-settings-tools.spec.ts` asserts
the operator-only anchor count the docs quote (20 → 21) and `settings.store.spec.ts` asserts the
exact MCP settings list. Both exist to force the prose to keep up, so `docs/AIO_MCP_CLI.md` and
`docs/llm/AIO_MCP_CLI_REFERENCE.md` were updated to say 21 anchors and six Computer Use keys.

**Verification, 2026-08-26:**

```
npx tsc --noEmit                       → 0
npx tsc --noEmit -p tsconfig.spec.json → 0
npm run lint                           → 0
npm run check:ts-max-loc               → 0
npm run build:main                     → 0
npm run test:quiet                     → 7 failures, none in this task's scope
```

Those 7 are in `copilot-accounts-tab.component.spec.ts` and belong to a concurrent session's
in-flight `COPILOT_ACCOUNT_DISCOVER` work. Proven not attributable to this task by extracting a
clean `git archive HEAD` tree, copying in only this task's files, and running the affected specs
there: **240/240 passed**, including all 7.

Scoped coverage: `desktop-app-policy.spec.ts` (43 cases), `desktop-input-policy.spec.ts` (24 cases),
and level-sensitive end-to-end cases in `desktop-gateway-service.spec.ts`. The pre-existing service
spec is pinned to `guarded` and passes unchanged, which is the evidence for acceptance item 3.

**Independent completion gate:** `VERDICT: PASS`, no actionable findings. A fresh reviewer confirmed
all nine acceptance criteria, that the level is read fresh per decision rather than cached, that the
operator-only enforcement path is real rather than merely listed, and that `redactDesktopMetadata`
still redacts typed text on the audit path now that secret-like input is permitted.

---

## Reopened, and why (2026-08-26)

The first close was premature. A completion gate had returned `VERDICT: PASS`, but a subsequent
adversarial bug hunt found six defects. Recorded in full because the most serious one was caused by
believing a plausible story instead of checking it.

**The false premise.** This plan originally claimed to fix a false-positive bug: the old matcher
joined `executablePath` into its haystack and tested bare words (`security`, `privacy`, `credential`,
`shell`, `payment`), so an app installed under a matching path would be hard-denied with no override.
That is true of the code and **unreachable in production**. `mapApp()`
(`platform/darwin-helper-client.ts:361-390`) sets `appId`, `displayName`, `platform`, `bundleId`,
`pid` and `windows` — never `executablePath` — and nothing else in the repository writes it. A
theoretical fix was reported as a real one.

**What that cost.** Acting on the false premise, the loose patterns were narrowed and `wallet`/
`stocks` were anchored, which silently stopped denying about a dozen realistic apps at `guarded` —
"Wasabi Wallet", "ESET Cyber Security", "Git Credential Manager", "DuckDuckGo Privacy Browser" among
them — breaking this plan's own global constraint that `guarded` be a faithful revert. The nine-app
fixture asserting that constraint happened to contain only survivors, so it passed. A fixture list
chosen by the same person who wrote the change is not evidence.

### The six fixes

1. **`guarded` equivalence restored.** Original patterns reinstated verbatim. Proof is no longer a
   fixture: `desktop-app-policy.equivalence.spec.ts` embeds the pre-change matcher and compares both
   across a cross-product of ~60 realistic names and ~17 bundle ids. It asserts nothing the old code
   denied is now allowed, and that the only divergence is `com.ai.orchestrator` — Harness by bundle
   id, which the old code did not know, i.e. strictly *stricter*. Re-narrowing any pattern fails
   seven tests.
2. **Self-control guard covered the packaged build only.** A dev Harness runs the stock Electron
   bundle (`CFBundleName: Electron`, `CFBundleIdentifier: com.github.Electron`);
   `app.setName('Harness (Dev)')` does not rewrite it, so no name or bundle rule matched and a dev
   window was reachable at `trusted` — precisely what the guard exists to prevent. Now identified by
   `app.pid === process.pid`, exact in both builds. Matching `com.github.Electron` was rejected: it
   would also block every other Electron app, which are legitimate targets.
3. **The primary Copilot path still stalled.** The earlier lazy-launch fix covered the exec adapter,
   but `createCliAdapter('copilot', …)` builds an ACP adapter and the factory still probed
   synchronously per spawn — the same up-to-5s main-thread block. The default-argument resolution is
   now memoized in `copilot-cli-launch.ts`, with `resetCopilotCliLaunchCache()` called from
   `cli-update-service.ts` after a successful update so a cached `null` cannot outlive an install.
4. **A comment that lied.** `ensureLaunchResolved()` claimed a retry-on-transient-failure path;
   `getDefaultCopilotCliLaunch()` never throws. Corrected.
5. **Agent-facing guidance was stale at the new default.** `desktop-mcp-tools.ts` still told agents
   sensitive controls, password fields and Enter/Space were blocked. Rewritten per level.
6. **A doc comment tripped a security guard.** `copilot-route-preflight.spec.ts` greps `src/main` for
   `createCopilotAdapter(` to find unrouted Copilot spawn paths; a prose mention in
   `copilot-cli-launch.ts` matched. Reworded, with an in-file warning to future editors. Adding a
   `CLASSIFIED_EXEMPTIONS` entry was rejected — the file is not a call site, and padding that list
   with non-call-sites is how such a guard stops meaning anything.

### Verification of the fixes (2026-08-26)

```
npx tsc --noEmit                       → 0
npx tsc --noEmit -p tsconfig.spec.json → 0
npm run lint                           → 0
npm run check:ts-max-loc               → 0
npm run build:main                     → 0
npm run test:quiet                     → 7 failures, none in this task's scope
```

The 7 are `copilot-accounts-tab.component.spec.ts`, owned by a concurrent session's in-flight
`COPILOT_ACCOUNT_DISCOVER` work. Earlier attributable-to-this-task proof: a clean `git archive HEAD`
tree with only this task's files copied in ran 240/240 green.

**Second independent completion gate:** `VERDICT: PASS`, no actionable findings, 142 tests across six
files. It specifically confirmed the embedded old matcher in the equivalence spec is faithful to
`HEAD`, which is the assumption the whole `guarded` proof rests on.

### Note on reading suite results

`npm run test:quiet` exits correctly (`scripts/run-tests-quiet.js:518` floors a failing run to 1).
But when it is run inside a compound shell command, the reported status is the *last* command's — a
trailing `grep` that matches makes a red suite look green. Read the `✗ N of M tests failed` summary
line, never the exit status of a compound command. This cost one false "all green" claim in this
session before it was caught.

### Follow-up

Session-scoped elevation ("super YOLO") is specified and planned separately in
[2026-08-26-session-scoped-computer-use-autonomy_plan_completed.md](./2026-08-26-session-scoped-computer-use-autonomy_plan_completed.md).
