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
> a matching implementation-status section in
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. Per-check evidence still goes in
> the owning `*_livetest.md`.
>
> Finish with a status report at `docs/plans/<today>-livetest-backlog-status-report.md`.

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

### Dev app — for anything interactive

```bash
npm run build:main
# the renderer must be served; if nothing is on :4567 yet:
#   npm run start:renderer -- --port 4567
nohup npx electron . --remote-debugging-port=9444 > _scratch/dev-app.log 2>&1 &
sleep 25 && curl -s http://127.0.0.1:9444/json/version
```

Then evaluate JS in the renderer (expression read from a file to avoid shell quoting):

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
Emulation.setPageVisibilityOverride { visibility: 'visible' }
```

After that `document.hidden:false`, rAF fires, and the DOM updates on its own with no forced change
detection. A ready-made harness that does this: `_scratch/lt-2026-08-11/cdp-eval.mjs`.

Same root cause as LT-032/LT-033 — but note it cuts the *other* way here. As a product defect the
stuck-frame shape hides behaviour; as a **harness** fault it invents it. Before filing any renderer
"never rendered" finding, rule this out. Any older CDP-driven finding of that shape, recorded before
focus emulation was used, is worth re-reading before it is trusted.

#### Running several agents at once

`harness-dev` is single-instance **per profile**, so parallel agents must not share one. Give each
its own `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-<batch>` and its own `--remote-debugging-port`; they can
all reuse one `ng serve` on `:4567`. Note an isolated profile is empty — checks needing the real
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

### Packaged app — for the real profile, and only that

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
| Dev-app log lines appear in the production log | The dev app writes `app.log` into the **production** profile (`Logger` reads `app.getPath('userData')` at import time, before the dev path is set). Timestamp-check every log-based claim against your dev-app window, or prefer zero-count assertions where contamination can only add. |
| Renderer behaves unlike current source | A pre-existing `ng serve` may be days old. Either restart it or treat renderer-side conclusions as provisional. Main-process answers (IPC results, DB rows) are unaffected. |
| Dev app won't start | `harness-dev` is single-instance. Check for a stale `SingletonLock` and any existing `electron .` process. |
| `sqlite3` says "command not found" mid-pipeline | `timeout` is not on macOS by default either. Avoid both in compound commands. |
| Killing a Codex CLI seems to kill unrelated sessions | It doesn't — `codex app-server` is **per-instance** (there can be 20+ parented to Harness). But gate every kill anyway (below). |
| The packaged app suddenly reports `localExtension: {state: "not_installed"}` mid-campaign | A batch's dev app took the machine's Chrome native-messaging manifest. It lives at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ai_orchestrator.browser_gateway.json`, is **machine-global**, and `AIO_DEV_USER_DATA_PATH` never isolated it — so the last app to start owns the local extension channel and the other one reports itself uninstalled with remediation text that wrongly blames the extension. Filed and fixed as LT-520 (packaged always wins; an unpackaged app declines unless `AIO_CLAIM_LOCAL_BROWSER_MANIFEST=1`), but **until the packaged app is rebuilt with that fix, every dev app you launch re-takes it**. `cat` the manifest to confirm, and restore it before the campaign ends — deleting a `/tmp/aio-lt-*` profile while the manifest points into it leaves the user's local channel broken until they restart Harness. Remote (`windows-pc`) browser work goes over the worker relay and is unaffected. |
| A tool call returns "requires approval" for the wrong machine | Browser-gateway prompts **once per session** about main-vs-worker routing ("Approve = run it here on the main machine. Deny = reroute…"). **Just retry the same call — the gate trips on the first browser-gateway call of the session whatever arguments you pass, and the second call is allowed.** Resolved 2026-08-19 in a fresh session, which is what the 2026-08-18 row said was needed to separate the two hypotheses: that day's "lead with `computer`, not `nodeId`" advice was right by accident. Measured 2026-08-19: first call *with* `computer: "windows-pc"` → gate; identical retry → allowed. So neither argument disambiguates anything; it is purely once-per-session. It is not a permanent block and needs no input from James, and clearing it implies no local-Mac work — a `computer`/`nodeId`-scoped call returns only that node's tabs. A whole browser batch was once written off as "structurally unreachable" on the original (inverted) advice. |

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
- **`uptime` before dispatching and before the suite.** Above ~30, wait. The brief already says this;
  the point is that the *orchestrator* has to obey it too, not just the batch agents.
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

- **Per-check evidence** → the owning `*_livetest.md`, as a new dated `## Evidence run — <date>`
  section. Preserve prior dated sections; never rewrite history.
- **Reproduced defects** → `docs/plans/livetest-remediation-register.md`
  (index row + full section) and a status section in
  `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. This is the spec's own rule 6.
- **Cross-cutting rollup** → `docs/plans/<date>-livetest-backlog-status-report.md`. **Not
  `_scratch/`** — that is disposable and the user will not find it there. `_scratch/` is fine for
  the working matrix and scratch scripts.
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
- [ ] Remove `/tmp/aio-lt-*` workspaces and `_scratch/` fixtures.
- [ ] Restore any setting you changed.
- [ ] Stop the dev app (it holds the `harness-dev` single-instance lock and will block the user).
- [ ] `git status --short` — confirm only intended changes, nothing staged, no `_completed` rename.
- [ ] `git worktree list` / `git branch --list` — confirm you created nothing.
- [ ] Run the gates: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, and the targeted
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
  longer exists on disk. Record them plainly and move on — see
  `_scratch/livetest-human-punchlist.md`.
