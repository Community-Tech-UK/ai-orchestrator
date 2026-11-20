# Live-Test Campaign Runbook

How to run a `*_livetest.md` campaign without rediscovering the same obstacles. Written after the
2026-07-26 session, which lost roughly an hour to problems this file now removes.

**Undated on purpose** — this is a standing runbook, not a plan or spec. It has no `_completed`
lifecycle. Keep it current; delete anything that stops being true.

---

## 1. The prompt to paste

> Run through the pending `*_livetest.md` docs older than 24 hours. Do as many as you can, don't
> stop to report between them.
>
> **Read `docs/plans/livetest-campaign-runbook.md` first and follow it.** In particular: launch the
> dev app yourself with a debug port, drive it over CDP, and don't restrict yourself to read-only
> evidence.
>
> Money on Codex/Claude/Antigravity is fine. Don't commit anything and don't rename any doc
> `_livetest_completed.md` unless every check in it genuinely passes.
>
> Any defect you reproduce goes into
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item
> (index row + a section with observed behaviour, root cause, required behaviour, acceptance), and
> implementation notes in the plan or livetest document that fixes it. The register index row owns
> the defect status. Run `node scripts/next-lt-id.mjs --reserve` before adding a row; keep the returned
> identifier for that defect and never delete its reservation. Per-check evidence still goes in the owning `*_livetest.md`.
> Read the register archive only when an index row points there; never add work to closed plans.
>
> Finish by updating `docs/plans/livetest-backlog.md`. Do **not** create a new dated
> status report — the fifteen that existed were merged into that one living document on
> 2026-09-06 and deleted.

If you want a narrower run, replace the first line with e.g. "Work only the reconciler-family
livetests" — everything else in the prompt still applies.

---

## 2. The single most important lesson

**Launch the dev app yourself, with a remote-debugging port, and drive its real IPC.**

The 2026-07-26 session first tried to work read-only against the packaged app, concluded "an agent
cannot send input to an instance, therefore most checks are undriveable", and wrote that up as the
headline blocker. That conclusion was wrong. Relaunching the dev app with a debug port found three
real product defects within about twenty minutes — including a P0 that destroys a live Claude
session on every YOLO toggle.

If a check needs a click, a keypress, a send, an interrupt or a terminate: **that is available**.
Do not report it as blocked without trying the CDP route.

Corollary: if the user says "we're working in the dev app", that is a scheduling conflict, not a
prohibition. Ask, or use it and stand it down cleanly afterwards — don't silently downgrade the
whole campaign.

---

## 3. Two environments, two different jobs

Turn the debug record on before a campaign that needs adapter-event evidence.
Leftover-folder removal is an ask-first action: review one folder, then get James’s confirmation before removing real folders or branches.

### Dev app — for anything interactive

**Start it with `dev-app.js`, not by hand on this Mac.** This overrides an older instruction you may have been given to
"build and launch the dev app from your worktree" or to set `AIO_DEV_USER_DATA_PATH` and `--remote-debugging-port`
yourself: use the same port and data folder with the command below instead. On 13 November 2026 four or five
live-test copies at once, each with its own build and screens server, held James's Mac at a load of about 30 on 18
cores. `dev-app.js` sends your checkout's files (uncommitted ones included) to the first computer that isn't busy, in
James's order: the test Mac, then the Windows PC (its Linux space, on a screen nobody sees), then this Mac. It installs,
builds and starts Harness there and tunnels the debugging port back, so `http://127.0.0.1:<port>` here reaches it and
every CDP step below works unchanged. Run it from inside your checkout or queue worktree; the path below finds the main
checkout's copy of the script, so it works in a worktree made before the script existed:

```bash
DEV_APP="$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/remote-checks/dev-app.js"
node "$DEV_APP" start --port 9444 --data /tmp/aio-lt-<batch>    # a few minutes; ~10 after a package change
curl -s http://127.0.0.1:9444/json/version                       # the copy, wherever it started
node "$DEV_APP" shell --port 9444 'ls "$AIO_DEV_USER_DATA_PATH"'  # its data folder is on that computer
node "$DEV_APP" stop --port 9444                                 # always, before you finish
```

- Give `start` your tool's longest timeout. If the tool cuts it off, run the same command again: it joins the copy
  that is still starting rather than building twice. Changed code? Run `start` again; it replaces the copy.
- A copy stops by itself 4 hours after it started (`start` and `status` print the time), and the connection here
  closes with it. Run `start` again for a fresh four hours. The data folder stays on that computer after a stop (it
  is under `/tmp`, so a restart there clears it), and a start with the same `--data` on the same computer carries on
  with it.
- Use only the port and data folder you were given. A port held here by anything else, or on the far computer by
  another live test's copy, is refused and that copy is left alone.
- **Never judge a computer's load yourself, and never stop or end your turn because one is busy.** `start` does that:
  busy means a 5-minute load of 1.5 per processor or more, or (on the test Mac or the PC) already three copies. It
  passes a busy computer by (except one already running your port's copy from the same files, which a rerun joins; a
  changed copy on a busy computer is stopped and rebuilt on one that isn't), and when all three are busy it prints
  `every computer is busy (...)` and keeps looking every 2 minutes until one is free, then starts the copy there (or
  exits 75 if this Mac is the one). Leave it running (in the background if your tool cuts commands off, then check its
  output); if it is cut off anyway, run the same command again. On 14 November 2026 a session saw the test Mac at a
  load of 35, decided by itself to hold its live tests, and sat idle until James noticed.
- Exit 75 means this Mac is the one free computer: use "On this Mac" below. `--mac`, for a check that needs a
  signed-in AI tool (see below), skips the PC. A signed package (`--packaged`) needs a remote Mac: it skips the PC and
  this Mac, never exits 75, and waits for the test Mac.
- Add `--remote-only` to `start` when the launch must stay on a remote computer. It keeps checking eligible remotes
  without considering this Mac's load or returning exit 75, including when they are busy, paused or unavailable.
  Combine it with `--mac` or `--packaged` to wait for an eligible remote Mac; a free PC is still skipped. The usual
  load and copy limits remain in force. Stop, status and shell do not take this launch option.
- What a copy can use depends on where it runs. On 13 November 2026 one on the test Mac could use Claude (signed in)
  and no other AI tool. One on the PC (measured 14 November 2026) draws every screen but has no AI tool signed in, so
  it suits checks of screens, settings and stored data, not ones that need a model to answer. Neither has this Mac's
  real profile, paired workers or browser. Ask the copy itself what it can use
  (`window.electronAPI.getStartupCapabilities()` over CDP) rather than assuming: a command run through `shell` comes in
  over SSH, which on a Mac can't read the keychain, so there `claude auth status` says signed out whatever the copy
  sees. When a check needs a signed-in AI tool, start with `--mac`: it waits for the test Mac or this Mac rather than
  taking the PC. When a copy still lacks what a check needs, stop it and use "On this Mac", and say why in the
  evidence.
- Files the copy writes (its data folder, `app.log`, databases) are on that computer: read them with `shell`, which
  runs in the copy's checkout. Screenshots and anything else you take over CDP arrive here as usual.

#### On this Mac (when `start` exits 75, or a check needs this Mac)

```bash
npm run build:main
# the renderer must be served; if nothing is on :4567 yet:
#   npm run start:renderer -- --port 4567
nohup npx electron . --remote-debugging-port=9444 > _scratch/dev-app.log 2>&1 &
sleep 25 && curl -s http://127.0.0.1:9444/json/version
```

Either way, evaluate JS in the renderer (expression read from a file to avoid shell quoting):

```bash
sed 's/9333/9444/' /tmp/cdp-eval.mjs > /tmp/cdp-eval2.mjs   # if the old helper exists
node /tmp/cdp-eval2.mjs /tmp/expr.js
```

#### ⚠ Enable focus emulation FIRST, or every DOM assertion lies to you

A dev app launched this way is **not visible**. `document.hidden` is `true`, `visibilityState` is
`'hidden'`, and **`requestAnimationFrame` never fires**. The renderer is zoneless, so Angular's
scheduler never flushes: signals and `computed`s are correct while **the DOM never updates**.

This does not merely hide real bugs — it *manufactures* them. On 2026-08-11 the `ToastService`
signal plainly held a toast while `.toast-stack` was absent from the DOM, which looked exactly like
a real "the error never reaches the user" defect. It was not one; `ng.applyChanges()` rendered it
instantly.

Send these on the CDP connection **before** `Runtime.evaluate`:

```
Emulation.setFocusEmulationEnabled  { enabled: true }
Page.setWebLifecycleState           { state: 'active' }
```

After that `document.hidden:false`, rAF fires, and the DOM updates on its own with no forced change
detection. A ready-made harness that does this: `_scratch/lt-2026-08-11/cdp-eval.mjs`.

**`Emulation.setPageVisibilityOverride` is gone.** On Chrome 144 / Electron 40 it returns
`-32601 'Emulation.setPageVisibilityOverride' wasn't found` (measured 2026-09-20). Treat the two
calls above as the current pair, and make the harness tolerate a missing method rather than abort on
it — an older helper that sends the removed call and dies takes the whole batch with it.

Same root cause as LT-032/LT-033 — but note it cuts the *other* way here. As a product defect the
stuck-frame shape hides behaviour; as a **harness** fault it invents it. Before filing any renderer
"never rendered" finding, rule this out. Any older CDP-driven finding of that shape, recorded before
focus emulation was used, is worth re-reading before it is trusted.

#### Running several agents at once

`harness-dev` is single-instance **per profile**, so parallel agents must not share one. Give each
its own `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-<batch>` and its own `--remote-debugging-port` (with `dev-app.js`,
its own `--data` and `--port`, and each copy gets its own screens server); copies started on this Mac can all reuse
one `ng serve` on `:4567`. Note an isolated profile is empty — checks needing the real
corpus, archived history or the paired worker still belong on the packaged app.

**Use the `AIO_DEV_USER_DATA_PATH` env var, not Electron's `--user-data-dir` flag.** The flag is
silently ignored for unpackaged launches because `app.setPath('userData', …)` overwrites it
unconditionally (`src/main/app/user-data-path.ts`); three batches once collided on one profile while
believing they were isolated. The env override was added as the fix (LT-060).

#### Subagents do not inherit MCP tools — use the stdio helper

A delegated batch agent gets Bash/Read/Edit/Write and **no `mcp__*` tool functions**. Briefing one to
"call `run_on_node`" or "call `graph_calendar_status`" therefore fails, and on 2026-08-18 that alone
made one batch report its whole subsystem "structurally unreachable".

All 44 orchestrator tools are reachable from any agent shell over stdio MCP, because the harness
injects `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET` and `AI_ORCHESTRATOR_INSTANCE_ID`:

```bash
node _scratch/lt-2026-08-18/aio-tool.mjs list                    # tool names
node _scratch/lt-2026-08-18/aio-tool.mjs describe run_on_node    # full schema
node _scratch/lt-2026-08-18/aio-tool.mjs call list_remote_nodes '{}'
```

That covers `run_on_node`/`read_node_output`/`terminate_node_instance`, `sync_*`/`upload_*`/
`download_*`/`list_node_files`, `get_setting`/`set_setting`/`list_settings`/`reset_setting`,
`list_automations`/`create_automation`/`delete_automation`, `evidence_*`, `graph_calendar_*`,
`git_batch_pull`, `request_doc_review`. Keep a copy of that helper alive across campaigns.

Two limits. It talks to the **packaged/production** app, so every write lands on James's real state —
read originals first, restore them, re-read to confirm. And **browser-gateway is not reachable this
way**: its forwarder needs `AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET`, which is absent from the shell.
Only the orchestrating session holds the browser tools, so browser checks must be proxied through it.

`window.electronAPI` exposes ~967 members, including everything a live test needs:
`createInstance`, `sendInput`, `interruptInstance`, `terminateInstance`, `toggleYoloMode`,
`changeModel`, `listInstances`, `skillsList`, …

`createInstance` accepts `provider`, `model`, `yoloMode`, `browserToolsMode`, `hardened`,
`launchMode`, `agentId`, `forceNodeId` — which is how you set up scenarios that no other path can
(e.g. `browserToolsMode: 'off'` for history-restore check 4, `hardened: true` for WS13).

Companion helpers from earlier sessions, if still present: `/tmp/cdp-emulate.mjs` (viewport override
via `Emulation.setDeviceMetricsOverride`), `/tmp/cdp-key.mjs` (real key events via
`Input.dispatchKeyEvent`), `/tmp/cdp-mouse.mjs`. `Runtime.evaluate` alone cannot do narrow-layout or
real-keyboard checks.

**Reaching Angular services:** `window.ng.getComponent(document.querySelector('app-root'))` gives
the root component; its injected fields (e.g. `ipcService`) are reachable from there. Note that
`contextBridge` objects are frozen — to inject a failure you must patch the **Angular service**, not
`window.electronAPI`.

#### A disposable worker node is something you can build, not something you wait for

Two checks in the Local AI Guard document sat unrun from 2026-07-29 to 2026-09-21 because they
needed "a disposable worker" and the only node ever connected is `windows-pc`, James's real one.
Nothing in those checks required a *separate machine* — only a worker that could be broken and
thrown away. A second worker agent on the coordinator Mac satisfies them, and costs about five
minutes:

```bash
npm run build:worker-agent            # dist/worker-agent/index.js, same commit as the dev app
# in the dev app renderer, over CDP:
#   setSetting('remoteNodesServerPort', 4979)   # NOT 4878 — the packaged Harness owns that
#   setSetting('remoteNodesServerHost', '127.0.0.1')
#   setSetting('remoteNodesEnabled', true)
#   then RESTART the dev app (see the last note below), and after it is up:
#   remoteNodeIssuePairing({ label: 'lt-disposable-worker' })   → one-shot token
cat > /tmp/aio-lt-<batch>-workerhome/.orchestrator/worker-node.json <<'JSON'
{ "nodeId": "<a real UUID>", "name": "lt-disposable-worker",
  "coordinatorUrl": "ws://127.0.0.1:4979", "namespace": "default",
  "maxConcurrentInstances": 1, "workingDirectories": ["/tmp/aio-lt-<batch>-workerhome/work"],
  "reconnectIntervalMs": 5000, "heartbeatIntervalMs": 10000, "fileTransfer": {"enabled": false} }
JSON
HOME=/tmp/aio-lt-<batch>-workerhome AIO_WORKER_TOKEN=<pairing token> \
  node dist/worker-agent/index.js --config /tmp/aio-lt-<batch>-workerhome/.orchestrator/worker-node.json
```

Four things that will cost you time otherwise:

- **`nodeId` must be a real UUID.** `node.register`'s param schema demands one, but the socket layer
  authenticates first, so a human-readable id is accepted, stored, and only then rejected by the
  router with `RPC validation failed … "Invalid UUID"` — which reads like an auth problem.
- **Override `HOME`,** so the worker's config and log files land in `/tmp` instead of James's real
  `~/.orchestrator` (the single-instance lock is keyed on `namespace:nodeId` in `os.tmpdir()`, so a
  fresh UUID already keeps it clear of a real worker). Pass the pairing token via `AIO_WORKER_TOKEN`, never `--token`,
  which puts it in the process table.
- **Use a non-default server port.** The packaged Harness holds 4878; starting a second server there
  either fails or steals his workers.
- **The setting must be on at launch.** Enabling remote nodes in a *running* app starts the server
  with no `RpcEventRouter`, so the worker authenticates, reports `Registration accepted`, and is
  still reported `disconnected` forever — filed as LT-604. Restart the dev app after writing the
  setting.

A worker built this way advertises whatever local model server is listening on the worker host's
`127.0.0.1:11434` / `:1234`, so a ~40-line fake Ollama (`/api/version`, `/api/tags`, `/api/ps`,
`POST /api/generate` returning the exact-token canary) is enough to enrol a Local AI target and then
break it on demand by killing one process. Check whether real Ollama/LM Studio are *running* first —
installed but stopped is the safe case, and it is the normal state on this Mac.

A worker that must really be **Windows** (a check of Windows paths, such as sidechat LT-SC-7) comes from the PC
instead. `dev-app.js start --pc ...` puts the copy on the PC's Linux space (never this Mac), and the same two settings
apply there (a free port, not 4878; on at launch). Issue the pairing token in the copy, then:

```bash
printf '%s\n' "$TOKEN" | node "$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/remote-checks/dev-app.js" \
  worker-start --port <debugging port> --coordinator-port <remote nodes port>
node .../dev-app.js worker-stop --port <debugging port>
```

`worker-start` runs a copy of the installed Windows worker's files, as a separate worker, under a folder of its own in
Windows's temp folder (its own home, config, logs, node id and one workspace folder). The receipt gives the node id and
the Windows workspace to pass as `forceNodeId` and the working directory. It never touches the installed worker, its
pairing or its updates; `worker-stop` (or the copy stopping) kills it and removes the folder, and says whether both
are gone. `worker-stop` also revokes the worker's node in the copy through its debugging port and waits (up to a
minute; the copy drops a dead worker's connection after about 30 seconds) until `remoteNodeList()` no longer lists it.
The token goes through the environment only, never a command line or a file.

### Signed test package — for packaged behaviour without the real profile

Use the same remote runner with `start --packaged --port <owned-port> --data /tmp/aio-lt-<owned-name>`.
It builds the normal signed directory package in its owned copy and starts it with a validated private profile;
it neither installs nor publishes the app. Keep its launch and runtime receipts. Use `--checked-tree` when a
checker must prove the running build matches its reviewed checkpoint. Follow the
[capability-repair runbook](livetest-capability-repair-runbook.md) for signing credentials and cleanup.
Do not substitute a fake home or symlink a keychain to obtain profile isolation.

### Installed production app — only for checks requiring the real profile

`/Applications/Harness.app` has **no debug port**. Use it when a check specifically needs the real
profile: the 2.9 GB RLM corpus, real archived history, the live `windows-pc` worker, real long-lived
sessions. What you can drive there:

- **Automations** (`create_automation` with `runAt` + `provider` + `workingDirectory`) — the only
  agent-reachable way to spawn a real provider session in the packaged app.
- Read-only assertions against `~/Library/Application Support/harness/{logs/app.log,
  conversation-ledger/conversation-ledger.db, rlm/rlm.db}`.
- Orchestrator MCP (settings, remote nodes, file transfer), browser-gateway MCP, verified `kill -9`.

**Automations deliver their prompt as the instance's *initial prompt at spawn*.** That path does not
run `buildInputContexts`, so it never triggers RLM/unified-memory/skill retrieval. Any check about
context injection, skill activation or send-time behaviour **cannot** be tested via an automation —
use the dev app and a real `sendInput`.

---

## 4. Gotchas that will cost you time

| Symptom | Cause / fix |
| --- | --- |
| `ERR_DLOPEN_FAILED` running any script that opens a DB | `better-sqlite3` is built for Electron's ABI. Run under Electron's node: `ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/tsx/dist/cli.mjs scripts/…`. **Never rebuild the module** — it breaks `npm run dev`. |
| A signal/`computed` is right but the DOM never changes; a toast/banner "never renders" | The dev-app window is occluded, so rAF never fires and the zoneless scheduler never flushes. **Not a product bug.** Enable focus emulation (above) before asserting on the DOM. |
| `terminateInstance('id')` fails with `expected object, received string` | Most IPC takes an object: `terminateInstance({instanceId})`, `sendInput({instanceId, message})`, `compactInstance({instanceId})`. |
| A provider swap you expected to be refused succeeds | `antigravity` is **detected and available** even though `command -v antigravity` finds nothing. For a guaranteed local refusal use `gemini` — a valid `CliType` deliberately excluded from `SUPPORTED_CLIS`. |
| Dev-app log lines appear in the production log | Historical builds selected their profile after importing loggers. Current `main-process-entry.ts` sets the validated profile before importing the app. Read logs through the owned remote runner and verify the runtime receipt's profile; production-log contamination on a current build is a defect, not an expected testing shortcut. |
| Renderer behaves unlike current source | A pre-existing `ng serve` may be days old. Either restart it or treat renderer-side conclusions as provisional. Main-process answers (IPC results, DB rows) are unaffected. |
| `window.ng` is `undefined`, so no component, store or router is reachable | You served a **production** renderer build. `ng build --configuration production` strips the debug global; `ng build --configuration development` (~14 s) keeps it. Without it you cannot click a real button or read a real signal, only the preload API — which is exactly how a broken renderer→preload seam gets missed. |
| The app reloads into a 404 page after `location.reload()` | Whatever is serving `dist/renderer/browser` has no SPA fallback (`python3 -m http.server` does not), so a deep link like `/skills` 404s. Serve it with a fallback to `index.html`, or drive routing through the Angular router instead of reloading. |
| Dev app won't start | `harness-dev` is single-instance. Check for a stale `SingletonLock` and any existing `electron .` process. |
| A session the dev app starts (a Plan Queue worker, say) calls a Harness tool and the answer comes from the real app ("Plan queue item not found") | The dev app inherited `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET`, `AI_ORCHESTRATOR_INSTANCE_ID`, `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY`, `AIO_MCP` and `CLAUDE_CONFIG_DIR` from the Harness session whose shell launched it, so its sessions' tool bridge points at the packaged app. Launch the dev app with a clean environment: `env -i HOME="$HOME" USER="$USER" PATH="$PATH" TMPDIR="$TMPDIR" PORT=<port> AIO_DEV_USER_DATA_PATH=/tmp/<yours> <Electron binary> … --remote-debugging-port=<yours>`. Confirmed 2026-11-12 (worker-report live check). |
| Sessions the dev app starts have no Harness tools at all (spawn log: `Orchestrator-tools MCP not configured — aio-mcp SEA binary, RPC socket or instance capability missing`) | A worktree has no `dist/aio-mcp-cli-sea/aio-mcp` until you run `npm run build:aio-mcp-dist` (about a minute). `build:main` alone does not make it. The builds can also rewrite `src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts` to the installed Codex version; revert it with `git checkout` before you finish. A scratch repository's `main` also moves whenever a queue run lands, so reset it to its first commit between runs. |
| `sqlite3` says "command not found" mid-pipeline | `timeout` is not on macOS by default either. Avoid both in compound commands. |
| Killing a Codex CLI seems to kill unrelated sessions | It doesn't — `codex app-server` is **per-instance** (there can be 20+ parented to Harness). But gate every kill anyway (below). |
| The packaged app suddenly reports `localExtension: {state: "not_installed"}` mid-campaign | A batch's dev app took the machine's Chrome native-messaging manifest. It lives at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ai_orchestrator.browser_gateway.json`, is **machine-global**, and `AIO_DEV_USER_DATA_PATH` never isolated it — so the last app to start owns the local extension channel and the other one reports itself uninstalled with remediation text that wrongly blames the extension. Filed and fixed as LT-520 (packaged always wins; an unpackaged app declines unless `AIO_CLAIM_LOCAL_BROWSER_MANIFEST=1`). **Confirmed live 2026-08-25 and no longer a hazard:** the packaged app now claims the manifest at start-up, and seven dev apps launched afterwards all declined it, logging `Another Harness install owns the Chrome native-messaging manifest — leaving it alone`. You no longer need to restore the manifest, and deleting a `/tmp/aio-lt-*` profile can no longer break the user's local channel. If you *do* still see this symptom, check the manifest's mtime against your dev app's start time before assuming the fix regressed — and note a dev app deliberately has no local extension channel of its own, so `browser.health` from a dev app reporting no local extension is expected, not a fault. Remote (`windows-pc`) browser work goes over the worker relay and is unaffected. **One exception found 2026-09-20 (LT-540):** a *packaged* app in startup-smoke mode (`AIO_STARTUP_SMOKE=1` + `AIO_STARTUP_SMOKE_USER_DATA_PATH`) still claims the manifest and points it at its throwaway profile, because the claim gate reads `app.isPackaged` and the manifest path comes from `os.homedir()`, not `userData`. If you build and run a packaged app during a campaign, snapshot that manifest's sha1 first and restore it afterwards. |
| A tool call returns "requires approval" for the wrong machine | Browser-gateway prompts **once per session** about main-vs-worker routing ("Approve = run it here on the main machine. Deny = reroute…"). **Just retry the same call — the gate trips on the first browser-gateway call of the session whatever arguments you pass, and the second call is allowed.** Resolved 2026-08-19 in a fresh session, which is what the 2026-08-18 row said was needed to separate the two hypotheses: that day's "lead with `computer`, not `nodeId`" advice was right by accident. Measured 2026-08-19: first call *with* `computer: "windows-pc"` → gate; identical retry → allowed. So neither argument disambiguates anything; it is purely once-per-session. It is not a permanent block and needs no input from James, and clearing it implies no local-Mac work — a `computer`/`nodeId`-scoped call returns only that node's tabs. A whole browser batch was once written off as "structurally unreachable" on the original (inverted) advice. |
| Packaging from an AIO worktree produces an app that exits 0 instantly with no window and no log | electron-builder cannot walk a `<repo>/.worktrees/*` `node_modules`, which is a **symlink farm** into the root checkout. It logs `cannot find path for dependency` for ~120 packages, silently omits them from the asar, and the app dies on the first `require` that needs one (`Cannot find module 'ret'`, via `safe-regex2` ← `settings-validators.js`). To see the error at all you must pass `--js-flags=--max-old-space-size=8192` yourself: without it `startHarnessMainProcess` relaunches and `app.exit(0)`s before anything is printed. Fix: materialise the unresolved symlinks as real directories (`rm node_modules/<d>; cp -R "$(readlink …)" node_modules/<d>`) and repackage; repeat until the warning is gone (three passes, 124 → 38 → 5 → 0, on 2026-09-20). Not a product defect. |
| You need a running signed package on an isolated profile | Use the owned remote runner's `--packaged` route above. Its explicit live-test context validates profile ownership and executable identity before imports. Do not use the old fake-home/keychain-symlink workaround. Provider authentication must still be checked through the actual running package and selected account. |
| You need a hardened instance sitting in `error` with a sandbox-denial classification (WS13 checks 10/11) | Three sessions failed to find a lever because they tried to make the CLI crash on its own startup write. Don't. Stage it: give the hardened instance a **real** jail denial in its output buffer (ask it to write outside the writable roots — `Operation not permitted` lands in the buffer), make it busy, `interruptInstance`, then `kill -9` its CLI within ~35 s. `interrupt-respawn-handler.ts:413` sets `autoRespawnSuppressedUntil = requestedAt + INTERRUPT_FORCE_ABORT_MS + 5_000`, which is what forces the exit down the **terminal** branch (`instance-communication.ts:2196`) that calls `noteSandboxDenialOnExit`, instead of auto-respawning. Levers that do **not** work: a child instance (auto-terminated the instant its turn completes), `restartInstance` to exhaust `restartCount < 5` (returns `Illegal transition: initializing → busy` and wedges the instance), and repeated kills (the respawn circuit breaker backs off 10 s then 30 s and the instance is terminated at restartCount 4). |
| A hardened spawn shows no `sandbox-exec` process in `ps` | Expected, not a bug. `buildSeatbeltCommand` returns `/usr/bin/sandbox-exec -p <policy> -D WRITABLE_ROOT_n=… -- <cmd>`, and `sandbox-exec` **`exec`s the target in place** — the jail survives, the argv does not. Any livetest step that says "`ps` shows the sandbox-exec invocation" is unobservable; assert on the `BaseCliAdapter: Spawning CLI under Seatbelt hardened mode` log line (it carries `grantedRoots`) plus an actual allow/deny write probe instead. |

### Host overload is the thing that will actually kill your run

Measured 2026-08-20. Eight batch agents died on the harness's 600s stream watchdog across two waves,
several while doing nothing heavier than reading files, and a full-suite run reported **18 failures
across nine unrelated spec files**. All nine passed **171/171 in isolation**, and none of them had
been modified. The cause was not the code, the API, or the agents:

```
load averages: 56.56  295.87  307.69
```

**Loadavg ~300, with memory fine at 78% free.** Pure CPU saturation. This is the same failure mode
already recorded in this project's history, where a loadavg of 290 killed healthy Codex sessions
through calm-weather watchdog timeouts.

What tipped it: an 8 GB-heap full suite (vitest spawns many workers) running at the same time as four
batch agents, their dev apps, the packaged app, a rebuild, and half a dozen loop agents the live app
was already running.

**Rules that follow, and they are cheap:**

- **Never run the full suite while batch agents are live.** It is the single biggest load contributor
  and it is exactly what the orchestrator is tempted to do "while waiting". Run it once, at the end,
  alone.
- **`uptime` before dispatching and before the suite.** Above ~30, wait, checking again every few minutes; never end
  your turn on it. The brief already says this; the point is that the *orchestrator* has to obey it too, not just the
  batch agents. This is about this Mac's own work: for a dev app copy, `dev-app.js start` checks every computer's load
  itself and waits when all are busy.
- **Do not diagnose a stall or a test failure without checking loadavg first.** Two hypotheses were
  wasted on this — API contention, then "no confirmed cause" — before anyone looked at `uptime`. The
  5- and 15-minute averages matter more than the 1-minute, which can look calm while the box is still
  digging out.
- **A failure that vanishes in isolation is a load artefact, not a flake to be retried.** Re-run the
  failing spec files alone before you touch anything; if they pass, the tree is green and the suite
  result is invalid, not the code.
- **Persist evidence incrementally.** A watchdog death under load costs whatever the agent had not yet
  written. Two agents lost a batch's worth of work this way; one had left an orphan register row with
  no section, and two more stalled mid revert-and-restore, which is the moment that leaves source in a
  reverted state.

### Safety gates before any `kill -9`

Snapshot pre-existing pids first, then require **all** of:

1. pid absent from the pre-campaign snapshot,
2. `ppid` equals the Harness main-process pid,
3. command line matches the expected CLI.

Refuse and abort otherwise. The packaged app hosts real user sessions and possibly the agent's own
session — never kill by pattern match alone.

---

## 5. Recording rules

The current backlog classification and operator punch-list live in
[`livetest-backlog.md`](livetest-backlog.md#environment-preflight--verified-2026-09-06).
Do not use `_scratch/livetest-matrix.md`, `_scratch/livetest-human-punchlist.md`, or an older dated
status report as present-tense authority; they are disposable or historical. Rebuild the current
matrix from active `*_livetest.md` files and the remediation register when the linked report ages.

“Needs James” is reserved for a real operator-only boundary: login/OAuth/MFA, credential entry,
TCC/System Settings, a hard-denied app, a physical device, destructive/release action, production
routing change, or an unresolved product choice. Local UI in general is not in that category: use
`windows-pc` first. After a failed preflight, report the result and ask whether to use the Mac,
wait or skip the browser step. Unattended campaigns must leave that step blocked; no answer means no. A
disconnected worker, missing fixture, open defect, absent read surface, or unimplemented feature is
a technical/external prerequisite, not a James action.

- **Per-check evidence** → the owning `*_livetest.md`, as a new dated `## Evidence run — <date>`
  section. Preserve prior dated sections; never rewrite history.
- **Reproduced defects** → `docs/plans/livetest-remediation-register.md`
  (index row + full section). The index row owns status; implementation notes go in the plan or
  livetest document that fixes it. Use `node scripts/next-lt-id.mjs --reserve` before adding the row. Reservations use the
  common root register and durable Git ledger; remote clones must ask the coordinator to reserve
  there. Never allocate from read-only output or delete reservations. See
  [defect identifier reservations](../defect-id-reservations.md). Read the archive only when an index row points there.
- **Cross-cutting rollup** → `docs/plans/livetest-backlog.md` (update in place). **Not
  `_scratch/`** — that is disposable and the user will not find it there. `_scratch/` is fine for
  the working matrix and scratch scripts.
- **A quoted main-process log line needs a source that outlives the run.** Redirecting Electron's
  stdout does not capture every structured log. Current startup selects the isolated profile before
  importing loggers. Read its logs through the owned remote runner, copy the redacted slice into the
  evidence directory before cleanup, and retain its timestamp and run/instance identifier. Removing
  the owned profile removes its logs; a citation to a temporary path alone is not retained evidence.
- **Running a doc as a Plan Queue item:** an item that reproduces no defect legitimately ends with
  **zero commits** on its branch. That is not lost work — the coordinator reads the untracked
  document from the root checkout and puts its `_completed` copy into the landing commit itself
  (`prepareClosedDocuments` → `buildLandingCommit`, `src/main/plan-queue/plan-queue-doc-close.ts`,
  `plan-queue-squash.ts`), and only after a verifier PASS. Do not copy the document into the
  worktree or commit it yourself.
- **Never** rename a doc `_livetest_completed.md` unless *every* check in it passes with current
  evidence. Partial passes stay open with the residual stated plainly.
- **Never** add content to a file already named `_completed`.
- Don't commit. Don't create branches or worktrees.

A pre-commit hook now **enforces** the last point across every project: staging any `_spec.md`,
`_spec_planned.md`, `_plan.md` or `_livetest.md` is refused. See `~/.config/git/hooks/README.md`.
If you hit it, that is the rule working — rename to a closed state or unstage; don't reach for
`--no-verify`.

To confirm coverage at any time (it tests the hooks for real rather than inspecting config):

```sh
sh ~/.config/git/hooks/verify-guard-coverage.sh
```

Be precise about confidence. "Exists in source" is not "runs on this path". If a probe fails,
establish whether the *feature* is broken or your *call* was wrong before writing it up — the
2026-07-26 session nearly filed a bogus "IPC broken end-to-end" finding that was actually a stale
renderer bundle plus an unused preload wrapper.

---

## 6. Cleanup checklist

- [ ] Delete every automation created (`list_automations` → `delete_automation`), including any
      auto-created "Resume session after … quota reset" the run provoked.
- [ ] Terminate disposable instances — `terminateInstance` works in the dev app; **the packaged app
      has no agent-reachable delete**, so instances created there must be listed for the user.
- [ ] Remove `/tmp/aio-lt-*` workspaces and `_scratch/` fixtures. (Since LT-520 was confirmed live on 2026-08-25, this no longer risks the Chrome native-messaging manifest — dev apps decline to claim it.)
- [ ] Restore any setting you changed.
- [ ] Stop the dev app (it holds the `harness-dev` single-instance lock and will block the user).
- [ ] `git status --short` — confirm only intended changes, nothing staged, no `_completed` rename.
- [ ] `git worktree list` / `git branch --list` — confirm you created nothing.
- [ ] Run the gates: `npx tsc --noEmit`, `npm run typecheck:spec`, and the targeted
      suites for anything you touched.

---

## 7. Realistic expectations

- A pending doc typically has 4–10 checks, and the *last* one is usually the expensive one. Getting
  a doc to "5 of 6" is normal; getting to 6 of 6 often needs a human artifact (an old binary, a
  signed release, an OAuth login) or a code fix.
- Expect to find defects. A campaign that reports "everything blocked, nothing found" is more likely
  under-driving the app than describing reality.
- Budget real time for provider turns. A session that must settle between sends costs 20–60 s per
  turn; a six-send skill probe is ~5 minutes of wall clock.
- Some blockers are genuinely external and no amount of effort moves them: unsigned releases
  (needs CI secrets + a pushed tag), an exhausted provider quota, an extension/binary build that no
  longer exists on disk. Record them plainly and move on — see the current operator list in
  [`livetest-backlog.md`](livetest-backlog.md#recommended-order-of-work).
