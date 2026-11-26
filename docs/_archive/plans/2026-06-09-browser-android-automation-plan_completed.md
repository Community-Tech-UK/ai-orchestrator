# Browser Audits + Android Testing — Full Implementation Plan

**Date:** 2026-06-09
**Status:** IMPLEMENTED — renamed with `_completed` after automated verification.
**Goal:** Make the Windows worker node a first-class target for (1) agent-driven browser UI/UX audits (Lighthouse, axe-core accessibility, viewport-matrix sweeps) and (2) agent-driven Android testing (managed emulators + physical devices), following the existing browser-automation architecture (Path 1: worker-injected MCP; Path 2: coordinator gateway/tunnel).

---

## 1. Where we are today

What already works and what we build on:

- **Worker plumbing:** worker agent connects to the coordinator over WS (mDNS discovery, enrollment/per-node tokens), reports capabilities (`src/worker-agent/capability-reporter.ts` → `WorkerNodeCapabilities` in `src/shared/types/worker-node.types.ts`), receives RPCs via `worker-rpc-dispatcher.ts` (method names in `src/main/remote-node/worker-node-rpc.ts`: `instance.spawn`, `config.update`, `browser.cdp.open/send/close`, `browser.stopManaged`, …).
- **Browser Path 1:** `WorkerBrowserManager` owns one long-lived Chrome with CDP on loopback against a dedicated automation profile. `LocalInstanceManager.resolveChromeDevtoolsMcp()` lazily ensures Chrome is up and passes `{ browserUrl }` into `createCliAdapter(...)`; `adapter-factory.ts` bakes a `chrome-devtools` MCP server into the spawn config per CLI (Claude/Copilot via `--mcp-config` JSON, Codex via TOML blocks, ACP adapters via `mcpServers` arrays).
- **Browser Path 2:** `worker-cdp-tunnel.ts` relays CDP frames worker↔coordinator; `src/main/remote-node/remote-cdp-tunnel.ts` is the coordinator side (puppeteer-core typings exist for the Mac-side client).
- **Routing:** `NodePlacementPrefs.requiresBrowser` is a hard filter in `worker-node-registry.ts` scoring (`-Infinity` when `!caps.hasBrowserMcp`); `remoteNodesAutoOffloadBrowser` setting drives auto-offload.
- **Config push:** Settings → Remote Nodes pushes `browserAutomation` config via privileged `config.update`; worker persists to `~/.orchestrator/worker-node.json`, restarts managed Chrome, re-reports capabilities. `worker-config.ts` enforces "ignored unless `enabled` is exactly `true`" and drops malformed optional fields.
- **Repo sync:** block-level delta sync (`src/main/remote-node/sync/*`: directory-scanner, block-signature, delta-generator/applier) exposed worker-side by `sync-handler.ts`, sandboxed by `path-sandbox.ts` (`allowedRoots`). Workers report `workingDirectories`, `browsableRoots`, and `discoveredProjects` (ProjectDiscovery scan).
- **Skills:** built-in skills live in `src/main/skills/builtin/<name>/` and are registered by `skill-loader.ts`/`skill-registry.ts`.
- **Android today:** nothing. The codebase has zero adb/emulator references; James's existing Android runs work only because spawned agents have a shell and the SDK is on PATH on the Windows node. Unmanaged: no routing, no lifecycle, no leasing, no structured tools.

### Conventions that constrain this plan

- TypeScript everywhere; Vitest, colocated `*.spec.ts`.
- `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc` (700-line cap per production file) must pass after every phase.
- Worker-agent code: **Node builtins only** — no Electron imports, no Puppeteer in the worker bundle (it's esbuild-bundled to a single `dist/worker-agent/index.js`).
- Zod 4 for IPC/RPC payload schemas (`src/main/remote-node/rpc-schemas.ts`).
- Never commit secrets; profile dirs and tokens stay operator-owned.

---

## 2. Tooling decisions (researched 2026-06-09)

### 2.1 Android: mobile-mcp as the default injection

**Decision: inject `@mobilenext/mobile-mcp` (v0.0.59, Apache-2.0, actively maintained) as the Android equivalent of chrome-devtools-mcp.**

Why:
- npx-installable stdio MCP, Node 22+, Windows-supported — identical injection shape to chrome-devtools-mcp.
- Talks straight to **adb + UI Automator**. No Appium server, no JDK requirement for the automation path.
- **Every tool takes a `device` parameter** (adb serial, e.g. `emulator-5554`), so one injected server drives multiple emulators/devices and our leasing layer just tells the agent which serial it owns.
- Tool surface fits exploratory agent testing: `mobile_list_available_devices`, `mobile_take_screenshot`, `mobile_list_elements_on_screen` (accessibility tree with coordinates — the LLM-friendly primitive), tap/double-tap/long-press/swipe, `mobile_type_keys`, `mobile_press_button`, `mobile_open_url`, app install/launch/terminate/uninstall, orientation, screen size.
- Set `MOBILEMCP_DISABLE_TELEMETRY=1` in the injected env (PostHog telemetry is on by default).

**Optional second injection: Maestro MCP** (bundled in Maestro CLI ≥2.x, `maestro mcp`, native Windows since 1.39.9). Its sweet spot is converting agent exploration into re-runnable YAML flows (`inspect_view_hierarchy` → `run_flow`), i.e. persisting regression tests as CI artifacts. We model it as a second, opt-in worker capability (`maestro` detected on PATH) rather than a default — the agent context cost isn't justified for every spawn.

**Appium MCP (`appium-mcp` 1.84.x): opt-in only.** Excellent and very actively shipped, but brings JDK + Appium 3 session management and ~30 tools of context. The one scenario that justifies it is hybrid apps needing native↔webview context switching or AI-vision element finding on apps with broken accessibility trees. We leave a config hook (`androidAutomation.appiumMcp: true`) but do not implement beyond injection wiring; revisit if a real hybrid-app need shows up.

### 2.2 Emulator acceleration: WHPX, not AEHD

Google's AEHD hypervisor driver is **sunset December 31, 2026**. On the 9950X3D node we standardize on **Windows Hypervisor Platform (WHPX)** (works on AMD, coexists with Hyper-V). Phase 0 includes verifying `emulator -accel-check` and documenting the WHPX enablement step in the runbook. We do not take any AEHD dependency.

### 2.3 Browser audits: chrome-devtools-mcp native tools + a thin axe runner

chrome-devtools-mcp is at **1.2.0** and now covers most of the audit surface natively:
- **`lighthouse_audit` tool** — agents run Lighthouse against the managed Chrome with no extra server.
- **`emulate` tool** — viewport as `WxHxDPR[,mobile][,touch][,landscape]`, UA override, network throttling (Slow/Fast 3G/4G, Offline), CPU throttling, color scheme. This is the viewport-matrix primitive; no Android emulator needed for responsive audits.
- Performance traces with Core Web Vitals insights, screencast recording, network inspection.

The only gap is **axe-core accessibility scans**. Decision: ship a small worker-side runner script (`scripts/axe-audit.mjs`, bundled into the worker build) using `@axe-core/puppeteer` (4.11.x) connecting to the existing debug port via `puppeteer.connect({ browserURL })`. Agents invoke it through their shell tool; output is JSON to stdout. This avoids injecting a fourth MCP server and keeps puppeteer out of the worker-agent bundle (the script is a standalone artifact, spawned as a child process — same rationale as the existing "no Puppeteer in the worker" rule).

> Note: puppeteer-core is already a repo dependency (used coordinator-side). The axe runner is built as a separate esbuild output (`dist/worker-tools/axe-audit.mjs`) so the worker bundle itself stays Electron/puppeteer-free.

### 2.4 Real-device mobile web audits

For "real Android rendering matters" cases: `adb forward tcp:<port> localabstract:chrome_devtools_remote` exposes the emulator/device Chrome's CDP locally; chrome-devtools-mcp can attach to it via `--browserUrl`. We wire this as an optional mode in Phase 7 (stretch), not core.

---

## 3. Target architecture

```
Mac coordinator (Electron app)                 Windows worker node
┌──────────────────────────────┐               ┌──────────────────────────────────────┐
│ Settings UI (Remote Nodes)   │  config.update│ worker-config.ts                     │
│  • Browser automation badge  ├──────────────►│  browserAutomation / androidAutomation│
│  • Android automation badge  │               │                                      │
│ worker-node-registry         │  capabilities │ capability-reporter.ts               │
│  • requiresBrowser (exists)  │◄──────────────┤  + android: adb/emulator/AVDs/devices│
│  • requiresAndroid (new)     │               │                                      │
│ task-preflight / offload     │ instance.spawn│ local-instance-manager.ts            │
│  • auto-offload browser      ├──────────────►│  resolveChromeDevtoolsMcp (exists)   │
│  • auto-offload android (new)│               │  resolveMobileMcp (new)              │
└──────────────────────────────┘               │       │                              │
                                               │       ▼                              │
                                               │ WorkerBrowserManager (exists)        │
                                               │  one Chrome, CDP loopback            │
                                               │ WorkerEmulatorManager (new)          │
                                               │  AVD boot/reuse/cleanup, WHPX        │
                                               │ DeviceLeaseRegistry (new)            │
                                               │  serial ↔ instance leases            │
                                               │       │                              │
                                               │       ▼ spawned CLI instance gets:   │
                                               │  mcp: chrome-devtools (--browserUrl) │
                                               │  mcp: mobile-mcp (adb; device=serial)│
                                               │  env: ANDROID_SERIAL, lease prompt   │
                                               │  shell: scripts/axe-audit.mjs        │
                                               └──────────────────────────────────────┘
```

Design principles carried over from the browser work:
- **Sessions and devices stay on the node.** adb, the emulator console ports, and Chrome CDP bind to loopback; nothing device-facing is exposed to the LAN. The coordinator reaches devices only through agents running on the node (or the existing tunnel pattern if we later add an "adb tunnel" — out of scope).
- **Lazy lifecycle.** Like Chrome, the emulator boots on the first Android-enabled spawn, not at worker startup.
- **Degrade gracefully.** If the emulator fails to boot, spawn proceeds without Android tools and logs why (mirrors `resolveChromeDevtoolsMcp` failure handling).
- **Config is push-able.** Everything configurable lands in `worker-node.json` and is editable from the Mac via `config.update`.

---

## 4. Phases

Ordering rationale: capability detection first (everything else keys off it), then worker-side lifecycle, then injection, then routing/UI, then the audit workflow (which is mostly skill/script work and can overlap), then docs/hardening. Each phase ends green on the four quality gates and is independently shippable.

### Phase 0 — Groundwork and node provisioning (no code, ½ day)

1. On the Windows node: enable Windows Hypervisor Platform; verify `emulator -accel-check` reports WHPX; confirm `adb`, `emulator`, `avdmanager` resolve (standard SDK paths: `%LOCALAPPDATA%\Android\Sdk`).
2. Create a dedicated test AVD via `avdmanager` (e.g. `aio-pixel7-api35`, google_apis x86_64) and verify headless boot: `emulator -avd aio-pixel7-api35 -no-window -no-audio -no-boot-anim` then `adb wait-for-device shell getprop sys.boot_completed`.
3. Add Android SDK + AVD directories to the existing Defender exclusions on the node.
4. Verify Node 22+ on the worker (mobile-mcp requirement; worker targets Node 20 today — see Risks §8).

**Acceptance:** documented commands succeed on the node; findings folded into the runbook (Phase 8).

### Phase 1 — Android capability detection + shared types (1 day)

**Files:**
- `src/shared/types/worker-node.types.ts`
  - Add `WorkerNodeAndroidAutomationSummary` mirroring the browser summary: `{ enabled: boolean; sdkPath: string; adbVersion?: string; avds: string[]; connectedDevices: AndroidDeviceInfo[]; emulatorRunning: boolean; hasMaestro: boolean }`.
  - Add `AndroidDeviceInfo`: `{ serial: string; kind: 'emulator' | 'usb' | 'wifi'; model?: string; apiLevel?: number; state: 'device' | 'offline' | 'unauthorized' }`.
  - Extend `WorkerNodeCapabilities` with `hasAndroidMcp: boolean` (the routing gate, computed like `hasBrowserMcp`: `enabled && adb resolvable`) and optional `androidAutomation?: WorkerNodeAndroidAutomationSummary`.
- `src/worker-agent/android/android-detect.ts` (new)
  - Resolve SDK root: config override → `ANDROID_HOME`/`ANDROID_SDK_ROOT` → platform-default paths (Windows `%LOCALAPPDATA%\Android\Sdk`, macOS `~/Library/Android/sdk`, Linux `~/Android/Sdk`).
  - `adb devices -l` parse → `AndroidDeviceInfo[]`; `emulator -list-avds` → AVD names; `adb --version`; `maestro --version` probe.
  - All child-process calls with timeouts, never throw — return empty capability on any failure (same defensive style as `detectGpu`/`detectDocker`).
- `src/worker-agent/capability-reporter.ts` — accept an optional android summary param (mirrors `browserAutomation` param) and populate the new fields.

**Tests:** `android-detect.spec.ts` with faked exec outputs (devices list variants incl. `unauthorized`, no-SDK case, malformed output); capability-reporter spec extended for `hasAndroidMcp` truth table.

**Acceptance:** a worker with the SDK reports AVDs + devices in its capability payload; a worker without it reports `hasAndroidMcp: false` and no crash.

### Phase 2 — Worker config block + `config.update` parity (½–1 day)

**Files:**
- `src/worker-agent/worker-config.ts`
  - Add `WorkerAndroidAutomationConfig`: `{ enabled: boolean; sdkPath?: string; defaultAvd?: string; headlessEmulator?: boolean (default true); maxEmulators?: number (default 1, cap 4); bootTimeoutMs?: number (default 180_000); allowPhysicalDevices?: boolean (default true); injectMaestroMcp?: boolean (default false); appiumMcp?: boolean (default false, wiring-only) }`.
  - Same loader rules as browser: block ignored unless `enabled === true`; malformed optional fields dropped; document each rule.
- `src/worker-agent/worker-rpc-dispatcher.ts` — extend the existing privileged `config.update` handling to accept/persist the `androidAutomation` block, restart/stop the emulator manager when relevant fields change, and trigger a capability re-report (identical flow to browser config updates).
- `src/main/remote-node/rpc-schemas.ts` — zod schema for the new block.

**Tests:** config loader spec (partial/malformed blocks can never enable; defaults applied); dispatcher spec for config-update → re-report.

**Acceptance:** editing `worker-node.json` or pushing `config.update` flips `hasAndroidMcp` within a heartbeat.

### Phase 3 — `WorkerEmulatorManager` + `DeviceLeaseRegistry` (2–3 days; the core build)

**Files (all under `src/worker-agent/android/`, Node builtins only):**

- `worker-emulator-manager.ts` — the `WorkerBrowserManager` analog:
  - `ensureRunning(avd?: string): Promise<AndroidDeviceInfo>` — boots the named (or default) AVD headless with `-no-window -no-audio -no-boot-anim` and a **pinned even console port** chosen from a free-port scan in 5554–5584 (`-port <even>`; serial is `emulator-<port>`), waits for `adb -s <serial> wait-for-device` + `sys.boot_completed=1` polling, with the configured boot-timeout budget. Quick Boot snapshots stay enabled for fast restarts.
  - Reuses an already-running managed emulator (probe `adb devices` and match our pinned ports) rather than booting duplicates — the single-Chrome-many-clients pattern applied to AVDs.
  - `maxEmulators` concurrency: subsequent `ensureRunning` calls for distinct AVDs boot additional instances up to the cap; beyond it, calls queue on existing instances.
  - **Orphan cleanup:** track child PIDs and pinned ports; on worker shutdown and on startup, kill any `qemu-system`/emulator processes bound to our port range that we own (port-pinning is what makes ownership detectable). Never touch emulators we didn't start (the operator may be running Android Studio).
  - Structured logging in the existing `[WorkerBrowserManager]`-style console format.
- `device-lease-registry.ts`:
  - `acquire(instanceId, prefs): Promise<DeviceLease>` where prefs can request `kind: 'emulator' | 'physical' | 'any'` or a specific serial. Emulator requests route through the emulator manager; physical requests pick an unleased `state === 'device'` serial.
  - One lease per device serial at a time; `release(instanceId)` on instance exit/kill (hook the same lifecycle points that clean up terminals/adapters in `local-instance-manager.ts`); TTL safety-net release for crashed instances.
  - Leases are advisory enforcement: the spawned agent's prompt/env names exactly one serial (below). We are not building an adb proxy that hard-blocks cross-device commands — agents have shells; document this honestly in the security section of the runbook.
- `worker-android-manager.ts` — thin facade composing detect + emulator manager + lease registry; the only thing `local-instance-manager.ts` and the RPC dispatcher talk to. Keeps each file well under the 700-line cap.

**Tests:** port allocation/collision spec; boot-timeout and boot-failure degrade spec (faked spawn + probe, mirroring `worker-browser-manager.spec.ts` injection points); lease acquire/release/double-acquire/TTL specs; orphan-cleanup ownership spec.

**Acceptance:** two concurrent Android-enabled spawns get distinct serials; killing an instance frees its lease; worker restart leaves no orphaned qemu processes from our port range.

### Phase 4 — mobile-mcp injection into spawned instances (1–2 days)

**Files:**
- `src/worker-agent/local-instance-manager.ts`
  - `resolveMobileMcp(params): Promise<MobileMcpAttach | null>` mirroring `resolveChromeDevtoolsMcp`: if android enabled → acquire lease (emulator boot if needed) → return `{ serial, kind }`; on any failure log + return null (spawn proceeds without Android tools).
  - Trigger only when the spawn requests it (placement prefs carry `requiresAndroid`; see Phase 5) — unlike browser, we should not lease a device for every spawn on an Android-enabled node.
- `src/main/cli/adapters/adapter-factory.ts`
  - New `options.mobileMcp?: { serial: string; maestro?: boolean }`.
  - Builders parallel to the chrome-devtools ones: Claude/Copilot `--mcp-config` JSON entry `{ "mobile-mcp": { command: "npx", args: ["-y", "@mobilenext/mobile-mcp@latest"], env: { MOBILEMCP_DISABLE_TELEMETRY: "1", ANDROID_HOME: <sdkPath> } } }`; Codex TOML block; ACP `mcpServers` array entries. Optional `maestro` entry (`maestro mcp`) when configured.
  - Version pinning: config-overridable `mobileMcpVersion` defaulting to a known-good pin (not `@latest`) — we own the upgrade cadence.
- **Lease handoff to the agent:** mobile-mcp targets devices per tool call via its `device` parameter, so the binding is contractual: inject `ANDROID_SERIAL=<serial>` into the instance env AND append a system-prompt fragment ("You are leased Android device `<serial>` (`<kind>`); pass it as `device` to every mobile tool; do not touch other serials") at the same place the spawn config assembles instance context.

**Tests:** adapter-factory specs for each CLI flavor (snapshot the generated mcp-config/TOML); local-instance-manager spec for lease-failure degrade + lease release on instance exit (extend `local-instance-manager.browser-inject.spec.ts` patterns).

**Acceptance:** a spawn with `requiresAndroid` on the Windows node yields an agent with working `mobile_*` tools that screenshots the leased emulator on first try.

### Phase 5 — Routing, placement, auto-offload (1 day)

**Files:**
- `src/shared/types/worker-node.types.ts` — `NodePlacementPrefs.requiresAndroid?: boolean` and optional `androidDeviceKind?: 'emulator' | 'physical' | 'any'`.
- `src/main/remote-node/worker-node-registry.ts` — hard filter beside the browser one: `if (prefs.requiresAndroid && !caps.hasAndroidMcp) return -Infinity;` plus a physical-device sub-check when `androidDeviceKind === 'physical'` (node must report ≥1 connected `usb|wifi` device). Small score bonus for nodes with an emulator already running (warm boot).
- Settings: `remoteNodesAutoOffloadAndroid` (default true) beside `remoteNodesAutoOffloadBrowser` in `settings.types.ts` / `settings.store.ts`.
- `src/main/security/task-preflight-service.ts` — wherever browser requirements are inferred/declared for tasks, add the android requirement path so Android tasks can't land on non-Android nodes.

**Tests:** registry scoring specs (filter, physical-device check, warm-emulator bonus); preflight spec.

**Acceptance:** an Android task from the Mac auto-routes to the Windows node; the same task with no eligible node fails preflight with a clear message instead of spawning and dying.

### Phase 6 — Settings UI parity (1–2 days)

Mirror the three-tier browser automation UI in `src/renderer/app/features/settings/remote-nodes-settings-tab.component.{ts,html}`:

- **Badge** per node: `Ready` (enabled + emulator or device verified) / `Enabled (starts on first use)` / `SDK only` (SDK detected, automation off) / `Off` (no SDK). Same semantics as the browser badge, driven by the new capability summary.
- **Configure Android automation** dialog: enable toggle, SDK path override, default AVD (dropdown from reported `avds`), headless toggle, max emulators, allow-physical-devices toggle, optional Maestro injection toggle. Apply → `config.update` push (existing privileged RPC path in `src/main/ipc/handlers/remote-node-handlers.ts`).
- **Devices panel:** read-only list of the node's reported AVDs and connected devices with state (`unauthorized` rendered as an actionable warning — "accept the USB-debugging prompt on the device").
- Angular 21 conventions already in the file: signals, draft-vs-applied state pattern (`draftAutoOffloadBrowser` et al.), zoneless. New component files if the tab nears the 700-line cap — likely split as `android-automation-config-dialog.component.ts`.

**Tests:** component specs following `remote-nodes-settings-tab.component.spec.ts` patterns (badge states, draft dirty-checking, apply flow).

**Acceptance:** enable Android automation on the Windows node entirely from the Mac UI, watch the badge go Enabled → Ready after first use.

### Phase 7 — Browser audit workflow (1–2 days, parallelizable after Phase 0)

The infra exists; this phase is tooling + skills.

- **Axe runner:** `scripts/worker-tools/axe-audit.mjs` (new esbuild target in the worker build scripts, output `dist/worker-tools/axe-audit.mjs`): args `--browser-url <url> --page-url <url> [--tags wcag2a,wcag2aa] [--viewport WxH]`; connects with `puppeteer.connect({ browserURL })`, opens a fresh page, runs `AxePuppeteer.analyze()`, prints JSON `{ violations, passes-count, url, viewport }`. Dep: `@axe-core/puppeteer` (devDependency is fine; it's bundled). The worker advertises the runner path via an env var (`AIO_AXE_RUNNER`) injected into browser-enabled spawns so agents don't guess paths.
- **Built-in skill `ui-audit`** (`src/main/skills/builtin/ui-audit/`): orchestrates the audit recipe against the injected chrome-devtools tools —
  1. viewport matrix via `emulate` (360x800x3,mobile,touch / 768x1024x2 / 1440x900x1 / 5120x1440x1 ultrawide) with screenshots per breakpoint;
  2. `lighthouse_audit` (performance/SEO/best-practices/a11y categories);
  3. axe runner via shell at each breakpoint;
  4. network/CPU throttle pass (`emulate` Slow 4G + 4x CPU) with Core Web Vitals trace;
  5. structured report: findings table (severity, breakpoint, screenshot ref, fix suggestion) written to the instance workspace.
- **Built-in skill `android-test`** (`src/main/skills/builtin/android-test/`): the exploratory-testing recipe — list devices, confirm leased serial, screenshot → `mobile_list_elements_on_screen` → act → verify loop, app install from a workspace-relative APK path, structured bug report format (steps-to-reproduce, screenshots, accessibility-tree excerpts). If Maestro is injected, a closing step persists discovered flows as YAML into the repo under test.

**Acceptance:** "audit https://example.com across mobile/tablet/desktop and report accessibility violations" produces a complete report from one Mac-side task with zero manual setup; same for an exploratory test of an APK.

### Phase 8 — Docs, runbook, hardening (1 day)

- `docs/android-automation-runbook.md` mirroring the remote-browser runbook: WHPX setup, AVD provisioning commands, USB-debugging authorization for physical devices, Defender exclusions, security model (below), troubleshooting (unauthorized devices, port collisions with Android Studio, snapshot corruption → `-no-snapshot-load`).
- Update `docs/WORKER_AGENT_SETUP.md` (optional Android SDK prerequisite) and `docs/remote-browser-automation-runbook.md` (audit tooling section: lighthouse_audit, axe runner, emulate matrix).
- Manual verification checklist entry per repo convention (`docs/2026-06-03-manual-verification-checklist.md` style).

---

## 5. Git/repo management on workers (the part James flagged)

Decision: **reuse the existing sync subsystem; add nothing new.** Rationale and policy:

- **Apps under test (APKs / built web apps):** artifacts flow to the worker through the existing block-delta file sync (`directory-sync-service.ts` + `sync-handler.ts`) into a sandboxed working directory (`path-sandbox.ts` allowedRoots). The `android-test` skill takes a workspace-relative APK path; no new transfer mechanism.
- **Source repos under test:** two supported modes, documented in the runbook rather than abstracted in code:
  1. *Worker-resident clone* (recommended for the Windows node): the repo lives on the worker (it already reports `discoveredProjects`); agents spawned there pull/build locally. Git stays ordinary git on one machine — no cross-machine worktree coordination.
  2. *Coordinator-pushed snapshot*: directory sync mirrors a Mac-side checkout to a worker working directory for test-only runs (no commits from the worker).
- **Hard rule, enforced by skill instructions and documented in AGENTS.md-style guidance for spawned agents:** instances on workers never commit or push from synced snapshots; commits happen only in mode 1 repos and only when the task explicitly says so (consistent with the repo's existing "never commit unless asked" rule).
- **Audit/test outputs** (reports, screenshots, Maestro flows) are written into the instance working directory and flow back through existing sync/file-transfer (`file-transfer-service.ts`) — they appear on the Mac without new plumbing.

The honest take: this is the easy part precisely because the sync + sandbox + project-discovery layers already exist. The plan deliberately avoids inventing a remote-git abstraction.

---

## 6. Security model

- adb server, emulator console ports, and gRPC ports bind to loopback on the node; nothing is LAN-exposed. Agents reach devices only by running on the node (Path 1), same trust model as browser automation.
- mobile-mcp injected as stdio (no listen port, no auth surface). Telemetry disabled via env.
- Leases are advisory (agents have shells). Mitigations: one device per instance contractually, lease prompt names the serial, and the runbook states plainly — as the browser runbook does — that an agent on an Android-enabled node can do anything adb can do to leased-or-not devices. Enable only on trusted, owned nodes; keep personal phones unplugged from the worker.
- Physical devices: USB-debugging authorization is a deliberate on-device human step; we surface `unauthorized` rather than trying to automate around it.
- Emulator images are disposable by design: document a `wipe-data` reset path; never log into personal Google accounts on managed AVDs (parallel to the dedicated-Chrome-profile rule).
- `config.update` for android stays on the privileged service scope like browser config.
- No secrets in any new file; SDK paths and AVD names are not secrets.

---

## 7. Testing strategy

- **Unit (vitest, colocated specs):** every new module listed per phase; the existing browser specs (`worker-browser-manager.spec.ts`, `local-instance-manager.browser-inject.spec.ts`, capability/dispatcher specs) are the templates — same injection-point seams (spawnProcess, probe, exec overrides).
- **Quality gates per phase:** `npx tsc --noEmit` + spec tsconfig, `npm run lint`, `npm run check:ts-max-loc`, `npm run test`.
- **Integration (manual, on real hardware, per phase acceptance):** the checklist items in §4 — these need the actual Windows node and can't be CI'd honestly. Scripted where possible (e.g. a `Justfile` target that runs the Phase 0 verification commands).
- **End-to-end smoke (after Phase 7):** one browser-audit task and one android-test task launched from the Mac, auto-routed, completing with reports synced back. This is the demo that proves the original goals.

---

## 8. Risks and open questions

1. **Worker Node version:** mobile-mcp requires Node 22+; the worker currently targets Node 20. Action: bump the worker prerequisite to Node 22 in Phase 0 (verify nothing in the bundle breaks; esbuild target update in `build-worker-agent.ts`). Low risk, but it's a prerequisite, not a footnote.
2. **Lease enforcement is advisory.** A confused agent can address the wrong serial. Accepted for v1 (matches the browser trust model); a hard-enforcing adb proxy is a known follow-up if multi-tenant pressure appears.
3. **Emulator flakiness** (boot hangs, snapshot corruption) is the most likely operational pain. Mitigations: boot-timeout budget with cold-boot retry (`-no-snapshot-load` on second attempt), orphan cleanup, runbook troubleshooting. Expect to tune timeouts on real hardware in Phase 3.
4. **Port collisions with operator-run Android Studio.** Our pinned-port range scan skips occupied ports, and ownership tracking means we never kill Studio's emulators — but the runbook should tell the operator the reverse can't be guaranteed (Studio may grab 5554 first; we just scan past it).
5. **mobile-mcp is pre-1.0** (0.0.x). Mitigated by version pinning + the config override; Appium MCP is the documented fallback if it stalls (the injection seam is tool-agnostic — only the builder functions change).
6. **AEHD sunset** is handled by standardizing on WHPX now.
7. **Facebook/social automation on the browser side** remains ToS-risky; that's an operational caveat already covered in the browser runbook, unchanged by this plan.
8. **Open question:** do we want Path 2 (coordinator-side tunnel) for Android — i.e. a Mac-side adb client over an RPC tunnel mirroring `browser.cdp.*`? Deliberately out of scope; Path 1 covers the stated goals and the tunnel adds real surface area for little gain until a concrete need appears (e.g. scrcpy-style live view in the Mac UI — noted as a possible future `android.screencast` RPC).

---

## 9. Effort summary

| Phase | Scope | Estimate |
|---|---|---|
| 0 | Node provisioning, WHPX, Node 22 | 0.5d |
| 1 | Capability detection + types | 1d |
| 2 | Config block + config.update | 0.5–1d |
| 3 | Emulator manager + lease registry | 2–3d |
| 4 | mobile-mcp injection | 1–2d |
| 5 | Routing/placement/preflight | 1d |
| 6 | Settings UI | 1–2d |
| 7 | Audit workflow + skills | 1–2d (parallelizable) |
| 8 | Docs + hardening | 1d |

**Total: roughly 9–13 focused days.** Phases 1–5 are the critical path; 6 and 7 can interleave. If we want value fastest: 0→1→2→4 (with manual emulator start) ships usable Android tooling in ~3 days, then 3 and 5 make it robust and routable.

---

## 10. File-change manifest (quick reference)

**New:**
- `src/worker-agent/android/android-detect.ts` (+spec)
- `src/worker-agent/android/worker-emulator-manager.ts` (+spec)
- `src/worker-agent/android/device-lease-registry.ts` (+spec)
- `src/worker-agent/android/worker-android-manager.ts` (+spec)
- `scripts/worker-tools/axe-audit.mjs` + esbuild target
- `src/main/skills/builtin/ui-audit/`, `src/main/skills/builtin/android-test/`
- `src/renderer/app/features/settings/android-automation-config-dialog.component.ts` (+spec)
- `docs/android-automation-runbook.md`

**Modified:**
- `src/shared/types/worker-node.types.ts` (capabilities, summary, placement prefs)
- `src/shared/types/settings.types.ts` (+ `remoteNodesAutoOffloadAndroid`)
- `src/worker-agent/capability-reporter.ts`, `worker-config.ts`, `worker-rpc-dispatcher.ts`, `local-instance-manager.ts`
- `src/main/cli/adapters/adapter-factory.ts` (mobileMcp builders)
- `src/main/remote-node/worker-node-registry.ts`, `rpc-schemas.ts`
- `src/main/security/task-preflight-service.ts`
- `src/renderer/app/core/state/settings.store.ts`, `features/settings/remote-nodes-settings-tab.component.{ts,html}`
- `src/main/ipc/handlers/remote-node-handlers.ts`
- `build-worker-agent.ts` (Node 22 target, axe runner bundle)
- `docs/WORKER_AGENT_SETUP.md`, `docs/remote-browser-automation-runbook.md`
