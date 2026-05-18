# AI Orchestrator — Improvement Recommendations (Pass 5)

> **Filename.** `claude5.md` continues the `claude_completed.md` → `claude2/3_completed.md`
> → `claude4.md` sequence. (It does not collide with the `CLAUDE.md` import stub —
> different name.) Rename to `claude5_completed.md` once this work lands.

## How this was produced — and why it's different

Passes 1–4 were **architecture and tooling** reviews (lint, provider abstraction,
error handling, the tool contract, sandbox, event registry, CI). They are largely
implemented. Pass 5 was run with **deliberately fresh eyes** on six angles **none of
the prior passes touched**:

- **A. Security** — Electron hardening & supply chain (not the sandbox/permission engine)
- **B. Performance** — runtime cost & the "thousands of instances" claim
- **C. Renderer** — UX & accessibility of the 412-file Angular app
- **D. Product** — what users can't do, and what's built-but-undiscoverable
- **E. Reality-check** — which subsystems are real vs scaffolding
- **F. Code health** — quantitative maintainability metrics

Six parallel research agents surveyed the sibling projects and `ai-orchestrator`
itself. **Every headline claim below was independently re-verified** against the live
tree (`npm audit`, `git ls-files`, `grep`, the packaged `release/` app). Numbers are
real.

## The through-line

`ai-orchestrator` is **not under-engineered — it is under-packaged and under-hardened.**
The main process is genuinely disciplined (0 `@ts-ignore`, 6 real TODOs, 1 stray
`console.*` in 811 files). But the ambition outran three things: **the security
boundary**, **the renderer's polish**, and **the gap between "code exists" and "a user
can reach it."** Most fixes below are *wiring and hardening*, not new engineering.

## TL;DR — priority order

| # | Improvement | Sev/Impact | Effort |
|---|-------------|-----------|--------|
| **A1** | Ship `@electron/fuses` hardening — defaults are all-permissive | **HIGH** | S |
| **A2** | Enforce IPC trusted-sender on all 715 handlers (currently ~5 files) | **HIGH** | M |
| **A3** | Zod-validate `remote-node` network-control handlers | MED | S |
| **A4** | `protobufjs` HIGH-CVE ships in prod; add an `npm audit` + secret-scan CI gate | MED | S |
| **A5** | Deliver CSP as a header; drop `style-src 'unsafe-inline'`; encrypt the enrollment token | MED | M |
| **B1** | Batch provider `output` events at the IPC boundary | High | M |
| **B2** | Cache prepared SQLite statements (~130 re-compiled per call) | High | M |
| **B3** | Parallelize + defer Electron startup (create the window earlier) | High | M |
| **B4** | Slim `serializeForIpc` — it copies every 500-msg output buffer | Med | S |
| **C1** | One modal shell with focus trap + Escape + focus restore (16 dialogs) | High | M |
| **C2** | Adopt or delete the 7 dead "Sprint 0" shared components | Med | M |
| **C3** | One global `prefers-reduced-motion` block | Med | S |
| **C4** | Replace 17 `window.confirm()` with a themed confirm dialog | Med | M |
| **D1** | First-run onboarding / setup wizard | Critical | M |
| **D2** | Make debate/verify/consensus invokable from a live chat | Critical | M |
| **D3** | Full-text conversation search (titles-only today) | High | M |
| **D4** | "Agent finished" desktop notifications | High | S |
| **D5** | MCP + plugin marketplace/catalog | High | M |
| **D6** | Give the 14 orphan routes a nav entry point | Med | S |
| **E1** | Cut or flag the GRPO "training" subsystem (scaffolding, marked "Done") | Med | S |
| **E2-5** | Wire or cut webhooks/reactions/observability; fix DEVELOPMENT.md status | Med | S–M |
| **F1** | Renderer must use the structured logger (45 files use raw `console`) | High | M |
| **F3** | Add a circular-dependency CI gate (19 cycles, unguarded) | Med | M |
| **F4** | Characterization tests for the untested `persistence`/`rlm` SQLite layer | High | M |
| **F5** | `git rm` two dead tracked files (incl. a 387 KB temp file) | Low | S |

Tackle **Section A first** — it contains the only HIGH-severity findings and they are
mostly effort-S. Then the **D quick wins** (D4, D6) — days of wiring that make the app
*feel* as capable as it is.

---

## A. Security hardening — Electron & supply chain

> Already covered by passes 1–4 (do not redo): the sandbox subsystem, the permission
> engine, approval-gated execution, secret redaction. The baseline is **good**:
> `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, DevTools
> gated to dev, secure `webSecurity` defaults, a CSP exists, `will-navigate` /
> `setWindowOpenHandler` guards present, API keys come from env not `electron-store`.
> The findings below are the gaps in that baseline.

### A1. The shipped DMG runs at Electron's permissive fuse defaults — **HIGH**

**Evidence (verified).** `package.json` has no `@electron/fuses` dependency;
`electron-builder.json` has no `afterPack`/`afterSign` hook; `grep` for
`fuses|flipFuses` finds nothing. So the packaged app
(`release/mac-arm64/AI Orchestrator.app`) ships at Electron defaults: **`RunAsNode`,
`EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` all enabled;
`EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` off; cookie
encryption off.**

**Why it matters.** `ELECTRON_RUN_AS_NODE=1 "AI Orchestrator.app/Contents/MacOS/AI
Orchestrator" -e '<code>'` turns the signed, entitled app into a general-purpose Node
process — running with the app's TCC grants and its on-disk SQLite/session data. ASAR
integrity off means `app.asar` can be patched post-install undetected. This is the
standard local-privilege-escalation / malware-persistence vector for signed Electron
apps.

**Fix.** Set `electronFuses` in `electron-builder.json`: `runAsNode: false`,
`enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`,
`enableCookieEncryption: true`, `onlyLoadAppFromAsar: true`, ASAR integrity on.
**Verify first** that the worker-agent / loop-control SEA builds and `scripts/` don't
rely on `ELECTRON_RUN_AS_NODE`. **Borrowed from** `CodexDesktop-Rebuild/forge.config.js`
(the *mechanism*; not its values — Codex leaves `RunAsNode` on). **Effort: S.**

### A2. IPC trusted-sender enforcement covers ~5 of 715 handlers — **HIGH**

**Evidence (verified).** `ipc-main-handler.ts` defines a solid `ensureTrustedSender` /
`ensureAuthorized` (validates `event.sender.id` + a per-session token). `grep` confirms
it is wired into only **5 files**. There are **715 `ipcMain.handle()` registrations
across 67 files** — the other ~62 files (including `remote-node-handlers.ts`,
`vcs-handlers.ts`, `mcp-handlers.ts`, `file-handlers.ts`, `settings-handlers.ts`)
receive `(event, payload)` and never check the sender. There is no global
`app.on('web-contents-created')` backstop.

**Why it matters.** If the renderer is ever compromised (XSS via a rendered AI response
or malicious markdown, a future `webSecurity` regression, a sub-frame), every
unprotected channel — git ops, CLI spawning, arbitrary file read/write, settings
mutation — is reachable. The auth machinery exists; it's opt-in instead of structural.

**Fix.** Route every `registerXxxHandlers` through one wrapper (or
`webContents.ipc` scoped to the main window) so a handler is **trusted-by-default** and
can't be registered without the check. Add `app.on('web-contents-created', …)` denying
`will-navigate` + `setWindowOpenHandler` as defense-in-depth. **Effort: M.**

### A3. `remote-node` network-control channels accept unvalidated payloads — MED

**Evidence (verified).** Most IPC files *are* well Zod-validated. The outlier:
`remote-node-handlers.ts` — 15 handlers, only 4 validated. `REMOTE_NODE_SERVICE_RESTART
/ _STOP / _UNINSTALL` and `REMOTE_NODE_START_SERVER` cast `payload` as a TS type and use
`payload.nodeId` directly; it flows into `sendServiceRpc(payload.nodeId, …UNINSTALL)`.
The schemas (`RemoteNodeRevokePayloadSchema` etc.) **already exist and are imported in
the same file** — just not applied.

**Why it matters.** Combined with A2 (no sender check here), a compromised renderer can
drive remote-node service control on *other machines* and bind the server to an
attacker-chosen host/port with type-confused input. **Fix.** Wrap each handler with the
existing `validateIpcPayload`. **Effort: S.**

### A4. A HIGH-CVE dependency ships in production; CI has no security gate — MED

**Evidence (verified).** `npm audit --omit=dev` reports **6 production vulnerabilities
(3 high, 3 moderate)**. `protobufjs` (HIGH — code-injection / prototype-pollution /
DoS advisories) is a **production** dependency via
`@opentelemetry/exporter-trace-otlp-http`. `uuid@13` carries a moderate buffer-bounds
advisory. `.github/workflows/ci.yml` has **no `npm audit` step, no secret scanning, no
Dependabot** (`.github/` contains only `workflows/ci.yml`).

**Why it matters.** Nothing stops a vulnerable dep or a committed secret from landing —
concrete risk, since the repo keeps a real bot token in `.env.local` (gitignored today,
one `git add -f` from leaking, no net).

**Fix.** Add `protobufjs` to the existing `overrides` block (or update the OTel
exporter); run `npm audit fix`. Add a CI `npm audit --omit=dev --audit-level=high` step
+ gitleaks. **Borrowed from** `agent-orchestrator/.gitleaks.toml` and
`openclaw/.pre-commit-config.yaml` — both are copy-pasteable from adjacent repos.
**Effort: S.**

### A5. CSP is meta-tag-only with `unsafe-inline`; enrollment token stored plaintext — MED

**Evidence (verified).** The only CSP is a `<meta>` tag in `src/renderer/index.html`
(`script-src 'self'` — good — but `style-src 'unsafe-inline'`). It is not delivered via
`session.onHeadersReceived`, so it can't enforce `frame-ancestors`/`object-src` and is
absent for non-document responses. Separately, no `electron-store` uses `encryptionKey`
(`grep "encryptionKey" src` → 0), so the **remote-node enrollment token** — the
credential that authorizes other machines to join the orchestration mesh — is written
cleartext to `settings.json` (`remote-node-handlers.ts` → `settingsManager.set(...)`).

**Why it matters.** Angular 21 rarely needs `style-src 'unsafe-inline'`; removing it
shrinks the XSS blast radius for the A2 scenario. A world-readable plaintext mesh-auth
token is readable by any process running as the user, any backup, any sync client.

**Fix.** Deliver CSP via `onHeadersReceived`, drop `style-src 'unsafe-inline'`, add
`object-src 'none'` + `frame-ancestors 'none'`. Pass an `encryptionKey` to the settings
store, or store the token via `safeStorage` (note: `index.ts` sets `use-mock-keychain`,
which disables OS-keychain-backed `safeStorage` — reconsider that for secrets).
**Effort: M.** *(Lower priority, separately: the `disable-library-validation` +
`allow-unsigned-executable-memory` mac entitlements in `build/entitlements.mac.plist`
are broader than Electron needs — test dropping them to just `allow-jit`.)*

---

## B. Performance & scalability

> **Reality note on the headline claim.** The README advertises scaling to "thousands
> of concurrent instances" / "10,000+". This is **aspirational, not architecturally
> supported**: each instance is a full OS process (`spawn()` in `base-cli-adapter.ts`),
> the main process declares a `CRITICAL_MB: 1536` ceiling (`shared/constants/limits.ts`),
> and **every load test mocks `better-sqlite3`** (`indexing/__tests__/load/*` use
> `vi.mock`). Nothing measures real spawn cost, IPC fan-out, or memory-vs-instance-count.
> Recommend either re-scoping the claim to low hundreds, or doing B1–B4 + honest
> benchmarks. None of B was touched by passes 1–4.

### B1. Provider `output` events stream to the renderer one IPC message each — unbatched

**Evidence (verified).** `provider-runtime-event-bus.ts`: `CRITICAL_KINDS` **includes
`'output'`**, and `enqueue()` calls `emitNow()` immediately for critical kinds — only
`context`/`status` are coalesced. Each event is a separate `webContents.send()` →
full structured-clone round-trip. The inversion is stark: the cheap *trace sink*
(`provider-runtime-trace-sink.ts`) batches 50 records / 200 ms, while the expensive
*renderer* gets the firehose.

**Fix.** Add a batching wrapper between the event bus and `sendToRenderer`: accumulate
`output`-kind envelopes per instance, flush as one `PROVIDER_RUNTIME_EVENT_BATCH` every
~50 ms. The `seq` field already supports ordered batches; `trace-sink.ts` is the
in-repo pattern to copy. **Effort: M.**

### B2. ~130 `db.prepare()` calls re-compile SQL on every invocation

**Evidence (verified).** **130 `db.prepare(` calls in `src/main/persistence/`**, every
one inside a function body — zero cached/hoisted statements. Hot paths (`indexSection`
per section, `addVector` per embedding, `TokenStatsService.record` per output message)
re-invoke the SQLite compiler each call, on the main (UI) thread.

**Fix.** Per-module lazy statement cache keyed by SQL string, or a `StatementCache`
initialized once. Highest-value first: `rlm-search.ts`, `rlm-vectors.ts`,
`rlm-stores.ts`, `token-stats.ts`. **Effort: M** (mechanical, ~20 store modules).

### B3. Electron startup is fully sequential; the window is created last

**Evidence (verified).** `index.ts` runs `for (const step of steps) await step.fn()` —
strictly serial — then `createMainWindow()` *after* the loop. ~23 steps + a serial
`bootstrapAll()`; the app opens ≥7 separate SQLite files (each a sync open + WAL +
migrations; `rlm-schema.ts` alone is 2,125 lines / 31 migrations) and registers 715 IPC
handlers before first paint. Only "IPC handlers" + "Event forwarding" are `critical`.

**Fix.** Split steps into `preWindow` (IPC, event forwarding, settings) and `postWindow`
(channels, codemem, observation, worker-node, hibernation…); create the window between
them; run `postWindow` with `Promise.allSettled` per dependency level — the
`BootstrapModule` graph already computes the topological order, it just executes it
serially. **Effort: M.**

### B4. `serializeForIpc` copies every instance's full 500-message output buffer

**Evidence (verified).** `instance-state.ts` `serializeForIpc` spreads `...rest`, which
still contains `outputBuffer: OutputMessage[]` (up to 500) plus a vestigial `messages`
field. `getAllInstancesForIpc()` maps it over every instance for the `INSTANCE_LIST`
channel — so one list refresh with 100 instances structured-clones ~50,000 message
objects synchronously, for a call that only needs id/status/displayName/contextUsage.

**Fix.** Project to a lightweight summary (the `toSlice()` shape already exists in
`instance-event-forwarding.ts`); fetch output buffers lazily per detail view. Delete the
dead `messages` field if confirmed unused. **Effort: S.**

### B5. The hottest events have duplicate listeners doing duplicate work

**Evidence.** `instance-event-forwarding.ts` registers **two** `provider:normalized-event`
listeners, each independently calling `toOutputMessageFromProviderEnvelope(envelope)` —
the transform runs twice per output event — and **four** `instance:batch-update`
listeners. `EventEmitter` invokes listeners serially, so this multiplies per instance.

**Fix.** Consolidate to one listener per event that computes the transform once and
fans out. **Effort: S.** *(Also: `completedChildNotifications` / `settledLastEmittedKey`
Maps in `instance-manager.ts` are populated but never deleted on `instance:removed` —
slow unbounded growth. Effort S.)*

---

## C. Renderer UX & accessibility

> The renderer foundation is strong — 97% of components are `OnPush`, a real
> design-token system with dark/light theming, a correct global `:focus-visible` rule.
> These are *consistency* gaps, verified via `grep`/`wc`. (Passes 1–4 and
> `copilot-t3code_completed.md` covered shortcuts-in-results, search ranking,
> 1-9 quick-select, resizable history, validated persistence, clipboard feedback — not
> repeated here.)

### C1. No focus trapping in any modal; half the dialogs can't be closed with Escape

**Evidence (verified).** `grep` for `cdkTrapFocus|FocusTrap|@angular/cdk/a11y` across
`src/renderer` → **0 matches**. There are 16 `role="dialog"` components; **8 have no
Escape handler** (e.g. `pause-detector-error-modal`, `hooks-config`, `skill-browser`,
`loop-config-panel`). No modal restores focus to its trigger on close. The command
palette's backdrop has `tabindex="0"` — it's *in* the tab order.

**Why it matters.** WCAG 2.4.3 / 2.1.2 — keyboard and screen-reader users Tab straight
through an "open" modal into the inert page behind it.

**Fix.** One `cdkTrapFocus`-backed `<app-modal>` shell with Escape + focus-restore baked
in; migrate all 16 dialogs. A correct hand-rolled keyboard menu already exists in
`instance-list.component.ts` (arrow nav, Home/End, focus wrap, restore) — extract its
logic. **Borrowed from** `t3code`'s Base UI `dialog.tsx`. **Effort: M.**

### C2. The "Sprint 0 shared components" library is dead code; 52+ features hand-roll primitives

**Evidence (verified).** `shared/components/index.ts` exports 8 components; **7 have
zero external imports** — `DataTableComponent`, `EmptyStateComponent`,
`StatusBadgeComponent`, `MetricCardComponent`, etc. Meanwhile **52 templates** hand-roll
`class="empty*"` markup. Empty/loading/error states are reimplemented 50+ times and
drift visually and in a11y.

**Fix.** Pick `EmptyStateComponent` as the wedge — migrate the ~10 highest-traffic empty
states to it, delete the genuinely unwanted exports, document the rest as canonical.
**Effort: M.**

### C3. `prefers-reduced-motion` is honored in exactly one file

**Evidence (verified).** 8 global `@keyframes` (incl. infinite `spin`/`pulse`/`glow`/
`shimmer`) and a bouncy `--transition-spring`. `grep` for `prefers-reduced-motion` →
**1 file**. `_animations.scss` / `styles.scss` have no reduced-motion query.

**Why it matters.** WCAG 2.3.3 — infinite loops are vestibular-trigger + battery risks.
**Fix.** One `@media (prefers-reduced-motion: reduce)` block in `_animations.scss`
zeroing `animation`/`transition` durations. **Effort: S** — highest leverage-per-line in
this section.

### C4. 17 native `window.confirm()` calls gate destructive actions

**Evidence (verified).** **17 `confirm()` call sites** across 12 components — archive
deletion, settings reset, destructive git/instance ops.

**Why it matters.** `confirm()` **synchronously blocks the entire renderer event loop**
(freezes signal updates, streaming output, timers), renders as off-theme OS chrome, and
is untestable/unstyleable.

**Fix.** A promise-returning `ConfirmService` + a themed dialog reusing the C1 modal
shell. **Borrowed from** `t3code`'s `alert-dialog.tsx`. **Effort: M.**

### C5. Error toasts announce as `polite` and auto-dismiss in 2.2 s

**Evidence (verified).** `app.component.html` wraps the whole toast stack — errors
included — in `aria-live="polite"`; `ToastService` uses a fixed `AUTO_DISMISS_MS = 2200`
for everything. There are three uncoordinated notification surfaces (`startup-banner`,
`resume-toast` — which has no `aria-live` at all — and `toast-stack`).

**Why it matters.** WCAG 4.1.3 — an error a screen-reader user (or anyone who glanced
away) never learns about. **Fix.** Split error toasts into `role="alert"` /
`aria-live="assertive"` with a longer/manual dismiss; consolidate the three surfaces.
**Effort: S–M.**

### C6. Only one list is virtualized; 388 `@for` loops render eagerly

**Evidence (verified).** `cdk-virtual-scroll` is used in **1 component**
(`instance-list`); feature templates contain **388 `@for` loops**, many over unbounded
collections (logs, history, archive, sessions, observations, memory). Scroll
restoration is near-absent.

**Why it matters.** Even with OnPush, Angular creates a DOM node + component per row;
a logs/history view with thousands of rows janks and spikes memory in a long-lived
Electron session. **Fix.** Wrap the 5–6 highest-cardinality lists in
`cdk-virtual-scroll-viewport` (CDK is already a dependency). **Effort: M.**

---

## D. Product gaps & discoverability

> `ai-orchestrator` has a *staggering* feature surface (67 feature modules) but the
> product packaging hasn't kept up. Two systemic problems: **power features are buried**
> and **there is no on-ramp**. Most of these are backend-exists / front-door-missing.

### D1. There is no first-run onboarding or setup wizard — **Critical**

**Evidence.** A repo-wide search for `onboard|first-run|welcome|wizard` finds only
`instance-welcome.component.ts` (the chat pane's empty state). `dashboard.component.ts`
`ngOnInit()` goes straight into the workspace — no first-run branch, no
`hasCompletedOnboarding` flag. The no-CLI path is a bare error screen. A new user never
learns Gemini/Codex/Copilot are supported, or that the marquee features (debate,
verification, supervisor trees) exist.

**Fix.** A 3–4 step modal: detect/choose providers with inline install help + live
re-check → pick a default working dir → 60-second tour of the marquee features →
optionally launch a first session. **Borrowed from** `openclaw onboard` (its README's
*preferred* setup path). **Effort: M.**

### D2. Debate / verify / consensus are orphan pages, disconnected from live chats — **Critical**

**Evidence.** `debate-page.component.ts` and `verification-dashboard.component.ts` are
standalone pages with their own "Query" textareas — you **retype the question from
scratch**. There is no "verify *this* response" / "debate *this*" action on a message or
in the input panel (`grep` in `features/instance-detail/` finds none).

**Why it matters.** This is the single biggest product miss: the headline capability —
multi-agent verification — is exactly what a user wants *in the moment they distrust an
answer*, and it's unreachable from where they are. The coordinators and inspector UIs
already exist.

**Fix.** Add per-message actions ("Verify this", "Debate this", "Second opinion") and an
input-panel mode toggle; the debate/verification pages become the *expanded inspector*
for a run started from chat. **Borrowed from** Claude Code's subagent model. **Effort:
M.**

### D3. "Global search" matches conversation titles only, not content — High

**Evidence.** `chat-search-page.component.ts` `entryMatches()` checks only
`displayName`, `firstUserMessage`, `lastUserMessage`, `workingDirectory` — assistant
responses, tool calls, and all middle messages are not searched. Results cap at 50,
client-side only. The app ships `better-sqlite3` and a whole `indexing/` +
`semantic-search/` subsystem — pointed at *code*, not conversations.

**Fix.** Back chat-search with a SQLite FTS5 index over message bodies; optionally reuse
the existing embeddings for fuzzy "conversations about X" recall. **Effort: M.**

### D4. No "your agent finished" notification — High

**Evidence.** `window-manager.ts` exposes one notification method,
`notifyUserActionRequest`, called only for *approval* events (`switch_mode |
ask_questions | approve_action`). Nothing fires on instance `idle`/`completed`,
`repo-job:completed`, debate/verification finishing, or a loop iteration ending.

**Why it matters.** The whole premise is "kick off work and walk away" — but the app
can't tap you on the shoulder when a 20-minute task (or a Loop, or an Automation)
finishes. **Fix.** Trigger the existing `Notification` plumbing on `instance.status →
idle` (after a busy period) and `repo-job:completed`; add a settings toggle. **Borrowed
from** `agent-orchestrator`. **Effort: S** — best value-to-effort in this section.

### D5. MCP servers and plugins have no marketplace — High

**Evidence.** MCP "Add Server" is a raw form (`id`, `command`, `url`); the only curated
item is one hardcoded "Add Chrome DevTools Preset" button. The Plugins "Discover" tab
scans local disk, not a remote catalog.

**Why it matters.** MCP is the 2026 integration standard; "which servers exist and what
do they do" is the #1 discovery problem. **Fix.** A curated MCP catalog (vendor/fetch
the official MCP registry JSON) + a plugin marketplace tab. **Borrowed from**
`claude-code/.claude-plugin/marketplace.json` (indexes 14 installable plugins).
**Effort: M.**

### D6. 14 powerful features have no navigation entry point — Med

**Evidence.** Diffing `app.routes.ts` (44 routes) against `sidebar-nav.component.ts`
(30): `mcp`, `plugins`, `models`, `hooks`, `snapshots`, `worktrees`, `archive`,
`remote-config`, `remote-nodes`, `memory/stats`, `operator`, `verification/settings`
and more have **no sidebar entry** — reachable only by typing a URL.

**Fix.** Triage the 67 features into a real information architecture; ensure *every*
shipped route has at least one discoverable entry point. **Effort: S** — components all
exist; this is nav restructuring.

**Also (lower priority, all backend-exists):** session **export** is wired in IPC
(`SESSION_EXPORT`) but has no button on chats/history — add an "Export ▾" (S); **cost
budgeting** has no proactive alerts or per-project attribution — add a live cost pill +
threshold notification reusing D4 (M); no **prompt/template library** despite a
workflow-template engine + markdown-command loader already existing — add a composer
picker (S–M); no **closed-loop PR review** — `agent-orchestrator`'s core use case
(agents fix CI failures, address review comments) — ai-orchestrator has worktree
coordination but no PR ingestion (L, highest strategic payoff).

---

## E. Subsystem reality-check & scope sprawl

> The codebase is *mostly real* — `memory`, `mcp`, `browser-gateway`, `channels`,
> `automations`, `repo-jobs`, `observation`, `codemem`, `hooks`, `workflows`,
> `remote-node` are all genuinely wired and UI-surfaced. The sprawl is concentrated and
> verified below.

### E1. The GRPO "training" subsystem is scaffolding — and is documented as "Done"

**Evidence (verified).** `learning/grpo-trainer.ts` (623 lines) + `training-ipc-handler.ts`
(485 lines) + a full Angular `/training` page. But: `getGRPOTrainer()` is **never called
from bootstrap** (verified — only `training-ipc-handler.ts` and a test-reset helper
reference it); `outcomes`/`batches` are **plain in-memory arrays** (`private outcomes:
TrainingOutcome[] = []`) — every restart wipes all "training" data; the only feed is a
manual "Record" button via IPC; `trainStep()` is an explicit no-op returning
`updates: []`. `DEVELOPMENT.md` line 223 lists it as **"Done"**.

**Fix.** Either **cut** the trainer + IPC handler + page, or **gate** `/training` behind
an experimental flag, persist via `RLMDatabase`, auto-feed from `OutcomeTracker`, and
re-label it. Do not leave it claimed "Done". **Effort: S** (cut) / **M** (finish).

### E2–E5. Smaller reality-check items

- **E2 — Dead observability exports.** `observability/otel-spans.ts` exports
  `traceVerification` / `traceDebate` / `traceInstanceLifecycle` — **0 callers each**;
  only `recordProviderRuntimeEventSpan` is used (one site). Delete the three, or wire
  them into the coordinators they name. **Effort: S/M.**
- **E3 — Webhooks half-wired.** `webhooks/webhook-server.ts` is a real HTTP server with
  a registered IPC handler, but **no preload domain and no `/webhooks` route** — a user
  can't create a webhook from the app. Finish the UI, or cut the 4 IPC channels.
  **Effort: M/S.**
- **E4 — `browser-automation/` is misfiled.** The top-level domain is a *single* file —
  a health *diagnostic* (`browser-automation-health.ts`); real automation lives in
  `browser-gateway/` (26 files). Move the file into `browser-gateway/`, delete the
  directory. **Effort: S.**
- **E5 — `DEVELOPMENT.md` "Done" list is unreliable.** Given E1–E3, replace the flat
  "Done" with an explicit vocabulary — `Shipped` / `Experimental` / `Backend-only` /
  `Scaffolding` — and re-audit the 60+ entries against init-site + renderer-surface +
  persistence. **Effort: S.**

---

## F. Code health & maintainability

> The main process is genuinely disciplined: **0 `@ts-ignore`**, **6 real TODOs**,
> **0 disabled tests**, **1 stray `console.*` in 811 files**. The problems are
> localized — the renderer never got the same discipline, coverage is uneven, and the
> dependency graph is unguarded. (The file-size cap was covered in claude4.md — not
> repeated.)

### F1. The renderer bypasses the structured logger — 45 files use raw `console`

**Evidence (verified).** `AGENTS.md` mandates `getLogger()`. Main complies (1 leak/811).
The renderer does not: **45 files** call `console.*` (30 with `console.error` in catch
blocks); a renderer logging bridge (`logging-ipc.service.ts`) exists but is imported by
only 3 of ~355 renderer files. `.oxlintrc.json` sets `"no-console": "off"`.

**Why it matters.** Renderer failures (instance creation, verification) never reach the
log file / observability pipeline — they exist only in DevTools, which users never open.
**Fix.** A renderer `LoggerService` over the IPC bridge; enable `no-console: error` for
the renderer; codemod the 45 files. **Effort: M.**

### F2. 148 `eslint-disable` directives cluster on two real smells

**Evidence.** **76** suppress `no-explicit-any` — the true `any` footprint is ~248, not
the ~109 a naive grep shows. **47** suppress `no-require-imports` / `no-var-requires`,
masking **109 untyped `require()` call sites** in TS source. One *whole-file* disable
sits on `security/self-permission-granter.ts` — a permission-granting file with linting
off. **Fix.** Triage the `any` suppressions; convert `require()` to typed dynamic
`import()`; replace the file-level disable with targeted line disables. **Effort: M.**

### F3. 19 circular dependencies, deep barrel-routed chains, no CI guard

**Evidence.** `madge` reports **19 cycles** in `src/main`; the worst spans 11 modules
across `instance → memory → session → automations → plugins → reactions → remote-node`,
every long chain routed through a domain `index.ts` barrel. `check-import-boundaries.js`
guards only *process-layer* boundaries — nothing checks inter-domain cycles.

**Fix.** Add `madge --circular` as a `verify:` script; break deep cycles by importing
concrete modules instead of domain barrels. **Effort: M.**

### F4. `persistence` / `rlm` / `agents` are near-untested — the highest blast radius

**Evidence.** Spec-to-source ratios: **`persistence` 1/22 (0.05)**, `agents` 1/17,
`rlm` 2/21, `hooks` 3/16. `persistence` holds the *entire* RLM SQLite stack —
`rlm-schema.ts` (2,125 LOC, 31 migrations), `rlm-vectors.ts`, `rlm-backup.ts`,
`rlm-knowledge-graph.ts` — schema, vector search, and backup have **zero tests**.
(By contrast `instance`/`providers`/`browser-gateway` are ~0.92 — the discipline exists,
it's just uneven.) The 614 spec files create a false sense of coverage.

**Why it matters.** A migration or backup-restore bug here corrupts user data silently.
**Fix.** Characterization tests for `rlm-schema` migrations (forward/backward),
`rlm-backup` round-trip, `rlm-vectors` search correctness. **Effort: M** for the
data-loss slice.

### F5. Dead code is git-tracked and shipped

**Evidence (verified — `git ls-files`).** Two stale artifacts are **tracked in git**:
`cross-model-review-service.js` (17 KB — an orphaned pre-migration copy of the live
`src/main/orchestration/cross-model-review-service.ts`, imported by nothing) and
`.tmp-vitest-session-review.json` (**387 KB** temp dump). **Fix.** `git rm` both; add
`.tmp-*` / `*.tmp.json` to `.gitignore`. **Effort: S.**

**Also:** worker-protocol types are defined twice independently
(`logging/log-writer-protocol.ts` and `observability/provider-runtime-trace-protocol.ts`
both declare `WorkerInbound/Outbound/Error/Shutdown`); `JsonRpcRequest` is re-typed in
5 files; `CacheEntry` in 11. Extract to `src/shared/types/`. **Effort: S.** Structural
conventions are also half-applied — 37/66 domains have barrels, test placement is split
214 co-located / 227 in `__tests__/`; pick one of each and document in `AGENTS.md`.

---

## Suggested sequencing

**Sprint 1 — Security & quick wins (~1 week, mostly effort-S):**
A1 (fuses), A3 (remote-node validation), A4 (audit gate + `protobufjs`), F5 (`git rm`
dead files), C3 (reduced-motion), D4 (completion notifications), D6 (orphan-route nav).

**Sprint 2 — The hardening & performance core:**
A2 (structural IPC trust), B1 (output batching), B2 (statement cache), B3 (startup),
B4 (`serializeForIpc`), F3 (cycle gate).

**Sprint 3 — Product packaging:**
D1 (onboarding), D2 (inline debate/verify), D3 (content search), D5 (marketplace),
C1 (modal shell), C4 (confirm dialog), F1 (renderer logger).

**Continuous:** E1–E5 (reality-check cleanup), F4 (persistence tests), C2/C6 (renderer
consistency).

## What's already strong (verified — do not redo)

Electron baseline security (`contextIsolation`/`nodeIntegration`/`sandbox`), the
sandbox + permission engine, the trace sink's exemplary batching, worker-thread codemem
indexing, `BoundedAsyncQueue` backpressure, renderer 97% OnPush + the design-token
system, the IPC-channel codegen, 0 `@ts-ignore` / 0 disabled tests in the main process.
Pass 5's findings are gaps *around* a solid core — not a verdict on the core.

---

*Pass 5 of the cross-project review — fresh-angle sweep (security, performance,
renderer/UX, product, subsystem reality, code health). All headline claims verified
against the live tree on 2026-05-15. Sibling sources: agent-orchestrator, openclaw,
opencode, t3code, claude-code, codex, CodexDesktop-Rebuild, mempalace-reference,
storybloq, and the wider `orchestrat0r/` set.*
