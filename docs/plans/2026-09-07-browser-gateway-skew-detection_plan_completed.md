# Browser Gateway: worker build-skew detection, honest health, and local target routing

**Status:** Implemented — agent-runnable gates green; remaining live checks in
[`2026-09-07-browser-gateway-skew-detection_livetest.md`](./2026-09-07-browser-gateway-skew-detection_livetest.md)
**Created:** 2026-09-07
**Completed:** 2026-09-08
**Origin:** Live incident. `windows-pc` failed every browser command for at least
two days with `browser_extension_runtime_incompatible` while every health surface
reported the node as ready.

## Incident summary (verified 2026-09-07)

Commit `e29b41ba` (2026-08-29, "browser gateway") made extension runtime evidence
(`extensionVersion` + `extensionStartedAt`) mandatory and fail-closed on the
coordinator, carried at the **top level** of `browser.ext.*` RPC params
(`src/main/remote-node/rpc-schemas.ts:410-437`).

The pre-`e29b41ba` worker does not put it there. Verified against the old blobs:

- old native host sent `payload: input.tab` — a bare tab, no evidence
  (`git show e29b41ba^:src/main/browser-gateway/browser-extension-native-host.ts`, `toAttachTabRpcInput`)
- old relay forwarded `payload: params.payload` verbatim, hoisting nothing
  (`git show e29b41ba^:src/worker-agent/worker-extension-relay.ts:180-191`)

On the current coordinator that means:

- `RemoteBrowserExtensionBridge.attachTab` → `recordExtensionContact()` finds no
  evidence → throws `browser_extension_runtime_incompatible`
  (`src/main/browser-gateway/remote-extension-bridge.ts:133-135`, `:285-287`)
- `pollCommand` → `allowBrowserCommands: false` → the command store rejects every
  queued command before delivery with the same code
  (`src/main/browser-gateway/browser-extension-command-store.ts:371-374`)

Observed: 984 `browser_extension_runtime_incompatible` entries in the current
`app.log`, all `browser.ext.attachTab`, all for node `bb62e3ee…`, continuous since
2026-09-05 22:49. Reproduced live three times via `browser.list_targets`.

**Why nothing flagged it.** The old relay still reports `extensionVersion` and
`extensionReloadedAt` in its capability summary — that reporting predates the
change (commit `60426dcc`, 2026-07-07,
`git show e29b41ba^:src/worker-agent/worker-extension-relay.ts:170-172`). So
`list_remote_nodes` shows `registration: "ok"`, `extensionVersion: "0.2.19"` and a
contact timestamp seconds old, while capability is entirely dead. There is no
protocol negotiation and no compatibility probe anywhere on this path.

The operational fix (redeploy the worker agent to `windows-pc`) is out of scope
here. This plan is about making the *next* skew self-announcing.

## Constraint discovered during investigation

`workerAgent.version` cannot be used as the skew signal. It is injected from
`packageJson.version` (`build-worker-agent.ts:5`) which is permanently `0.1.0`
and has never been bumped. `protocolVersion` in
`packages/contracts/src/schemas/remote-node.schemas.ts:187` belongs to the
*pairing* handshake only and does not cover the ongoing RPC contract.

Detection must therefore key on an explicit capability declaration, plus an
inference rule that works against workers that predate the declaration (which is
the whole point — a broken old worker cannot be asked to declare anything).

---

## Workstream 1 — Detect and name worker build skew

Goal: the coordinator says "the worker agent on windows-pc is too old, redeploy
it" instead of blaming the extension runtime.

### Step 1.1 — Worker declares the relay contract

- Add a relay contract marker to `WorkerNodeExtensionRelaySummary` (e.g.
  `forwardsRuntimeEvidence: true`), set in
  `src/worker-agent/worker-extension-relay.ts` `getSummary()`.
- Add it to the contracts schema alongside the existing relay summary fields.
- Absence of the marker on a node that reports `hasExtensionRelay: true` means
  the worker predates `e29b41ba`.

### Step 1.2 — Coordinator classifies the failure

In `remote-extension-bridge.ts` `recordExtensionContact()`, when evidence is
absent, distinguish two cases before failing:

- **Skew** — the node's relay summary reports a live `extensionVersion` (so the
  extension IS talking to the relay) but the params carried no evidence, and/or
  the relay contract marker is missing. Fail with a distinct reason,
  `browser_worker_agent_too_old`, carrying the node name and the remediation
  ("redeploy the worker agent to <node>").
- **Genuine runtime incompatibility** — everything else keeps
  `browser_extension_runtime_incompatible`.

The first branch must work with **no** worker-side change, since that is the only
branch that fires for an already-broken deployment. The Step 1.1 marker is the
cleaner long-term signal, not the primary one.

### Step 1.3 — Surface it where a human and an agent will see it

- Include the reason in the `list_targets` / `find_or_open` degraded summary
  string so an agent preflighting the gateway reads "worker agent too old" rather
  than a runtime error it will misattribute to Chrome.
- Log once per node per transition, not per request. The current failure mode
  wrote 984 identical lines and still went unnoticed; volume is not visibility.

### Step 1.4 — Tests

- Old-worker shape (params with no top-level evidence, relay summary reporting a
  version) → `browser_worker_agent_too_old`.
- New-worker shape with genuinely bad evidence (version below
  `BROWSER_EXTENSION_SECURE_CREDENTIAL_FILL_MIN_VERSION`) → unchanged
  `browser_extension_runtime_incompatible`.
- Node with no relay at all → unchanged behaviour, no new warning.

---

## Workstream 2 — Health must reflect capability, not liveness

Goal: `browser.health` cannot report `ready` while no channel can execute a
command.

### Step 2.1 — Fix the top-level status

`src/main/browser-gateway/browser-health-service.ts:379` currently reads:

```ts
status: chromeRuntime.available && bridgeAvailable ? 'ready' : 'partial',
```

That is "a Chrome binary exists and the MCP bridge is up" — nothing about whether
any extension channel can run a command. Extend the condition so a node in a
known-incapable state (Workstream 1's skew classification, or a channel whose
last N commands were rejected pre-delivery) forces at most `partial`.

### Step 2.2 — Fix the per-node readiness count

`browser-health-service.ts:491`:

```ts
ready: nodes.filter((node) => node.enabled && node.running && !node.silent).length,
```

Pure liveness. `windows-pc` counts as ready today. Add a capability dimension to
the per-node record (e.g. `commandsDeliverable: boolean` plus a reason) and
exclude incapable nodes from `ready`.

### Step 2.3 — Warn on incapable nodes

The node warning loop (`browser-health-service.ts:364-375`) only warns when
`node.silent`. Add a branch for "polling normally but rejecting every command",
with the remediation text. This is the sentence that would have ended the
incident on day one.

### Step 2.4 — Tests

Health fixture with one live-but-incapable node asserts: top-level status is not
`ready`, `remoteExtensions.ready` excludes it, and a warning names the node and
the remediation.

---

## Workstream 3 — `computer: "local"` returns remote targets

**Reproduced, NOT root-caused.** Do not start implementing until step 3.1 explains it.

### Evidence

Against the running packaged app (`app.asar` built 2026-09-07 11:36):

- `browser.list_targets { computer: "definitely-not-a-real-computer" }` →
  correctly denied, `browser_computer_not_found: … Available computers: local, windows-pc`.
  So the parameter IS parsed and resolved.
- `browser.list_targets { computer: "local" }` (no refresh) → returned 23 targets,
  every one carrying `nodeId: bb62e3ee…` / `nodeName: "windows-pc"`.
- With `refresh: true` it additionally returned windows-pc's failure reason:
  `inventory refresh FAILED for node bb62e3ee…`.

This is what made the earlier session conclude "the local channel is broken too".
It was reading a remote node's failure through a local-scoped request. That
misdiagnosis cost a session; the routing bug is worth fixing on its own.

### The contradiction to resolve first

The source says this cannot happen:

- `src/main/browser-gateway/browser-target-discovery-operations.ts:142` filters
  with `matchesBrowserComputerTarget(target, computerTarget.target)` **before**
  `toAgentSafeTarget`
- `src/main/browser-gateway/browser-computer-target.ts:110-112` — for
  `localOnly` this returns `!descriptor.nodeId`
- `BrowserTarget.nodeId` is present on the target at filter time
  (`packages/contracts/src/types/browser.types.ts:97`), and `toAgentSafeTarget`
  only strips `driverTargetId` (`browser-safe-dto.ts:40-44`) — it does not add
  `nodeId` later

`browser-target-discovery-operations.ts` last changed 2026-08-20 and
`browser-computer-target.ts` 2026-07-08, both well before the running build, so
this is unlikely to be simple build staleness — but the packaged app is ~6h older
than HEAD and that has not been excluded.

### Step 3.1 — Root-cause it (as-built)

Confirmed in source. The filter in `listTargets` is not bypassed. The MCP
server runs `routeBrowserGatewayRequest` **before** `listTargets`, and that
policy remapped an explicit `computer: "local"` onto the preferred
browser-capable worker:

```ts
return computerOnly.ok && computerOnly.target.localOnly
  ? withRemoteComputer(payload, preferredNode)
  : payload;
```

So `listTargets` received `{ computer: "windows-pc", nodeId: "bb62e3ee…" }` and
honestly returned that node's tabs. A garbage computer name was not remapped,
which is why `definitely-not-a-real-computer` still failed closed. This matches
the live evidence without needing a packaged-app rebuild to explain it.

### Step 3.2 — Fix, then cover

Explicit `computer: "local"` is no longer rewritten. Unscoped discovery still
auto-offloads. Tests cover: policy preserves local, `listTargets({ computer:
"local" })` returns only targets with no `nodeId`, and a local-scoped refresh
does not fan out to or report failures from remote nodes.

---

## Verification

Canonical checklist from `AGENTS.md`:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run build:renderer
npm run test:quiet
```

Live checks that need a rebuilt/restarted app, a real Chrome tab, or a
redeployed `windows-pc` worker are recorded in
[`2026-09-07-browser-gateway-skew-detection_livetest.md`](./2026-09-07-browser-gateway-skew-detection_livetest.md).

## As-built

- Worker `getSummary()` now declares `forwardsRuntimeEvidence: true`. The
  coordinator infers skew when that marker is absent **and** the relay reports
  a live `extensionVersion` (the pre-e29b41ba shape). Missing top-level RPC
  evidence on such a node fails as `browser_worker_agent_too_old` with
  "redeploy the worker agent to \<node\>". A new worker that forwards evidence
  for an extension below `0.2.18` stays `browser_extension_runtime_incompatible`.
- Incompatibility is logged once per node per reason transition, not per
  request. `list_targets` / `find_or_open` put the same reason in the
  agent-visible `reason` string.
- `browser.health` adds `commandsDeliverable` (+ optional reason) per node.
  Skew, or the last 3+ pre-delivery rejections, force top-level `partial`,
  drop the node from `remoteExtensions.ready`, and emit a warning that names
  the node and the remediation.
- Auto-offload still rewrites *unscoped* discovery onto a capable worker. It
  no longer rewrites an explicit `computer: "local"`.

## Out of scope

- Redeploying the worker agent to `windows-pc` (operational, do it separately)
- Any change to the security properties of the evidence check itself. Fail-closed
  is correct. This plan changes what the system *says* when it fails closed, not
  whether it does.
