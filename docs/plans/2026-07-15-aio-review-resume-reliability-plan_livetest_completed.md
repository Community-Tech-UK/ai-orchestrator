# AIO Review and Resume Reliability Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Status: Pending live validation

Related plan: [2026-07-15-aio-review-resume-reliability-plan_completed.md](./2026-07-15-aio-review-resume-reliability-plan_completed.md)

## Prerequisites

- Use a build from the `fix/aio-review-resume-reliability` worktree, or a later build containing the completed plan's changes.
- Fully quit the currently running AIO process before starting the rebuilt instance so the Electron singleton, provider sockets, and logs belong to the test build.
- Use a local Codex instance with cross-model review enabled and at least one available reviewer.
- Keep `config/mcp-servers.json` backed up and restore it immediately after check 2.

These checks are deferred because they require a rebuilt/restarted Electron app, live provider accounts, and controlled temporary modification of the app's static MCP configuration. Starting a second dev instance alongside James's active AIO session would not provide attributable evidence and risks colliding with its singleton/socket state.

## 1. Review input remains turn-bound and readable

1. Start the rebuilt app from this worktree.
2. Create a fresh local Codex instance.
3. Send: `Write one detailed response of at least 500 words about implementing a TypeScript retry queue. Include one fenced TypeScript block, but do not edit files.`
4. Let the response stream to completion and wait for cross-model review to start.
5. Before the review finishes, send: `New task: briefly explain AbortController in two paragraphs.`
6. Wait until the instance returns to idle.

Expected observable result:

- No review result for the first prompt appears after the second user message.
- Any later review is attached to the second task and does not report streaming token echo, repeated prefixes, artificial truncation, or unrelated first-turn requirements.
- The Codex answer remains readable as one streaming message in the transcript.

## 2. An unresponsive static MCP server fails open

1. Fully quit AIO.
2. Back up `config/mcp-servers.json` outside the repository.
3. Add this temporary server under `mcpServers`:

   ```json
   "aio-timeout-probe": {
     "command": "node",
     "args": ["-e", "setInterval(() => {}, 1000)"]
   }
   ```

4. Start the rebuilt app and create a fresh local Codex instance.
5. Send: `Reply with exactly: MCP startup recovered`
6. Observe the turn for 20 seconds and inspect the current app log for the `aio-timeout-probe` startup failure.
7. Fully quit AIO, restore the original `config/mcp-servers.json`, and restart normally.

Expected observable result:

- The temporary server is given `startup_timeout_sec = 10` in Codex's generated configuration.
- Codex reports or logs the optional MCP startup failure after approximately 10 seconds, then continues the turn and replies `MCP startup recovered`.
- AIO does not reach the 72-second stuck warning and does not auto-restart the instance.
- The restored normal build no longer lists `aio-timeout-probe`.

## Evidence to record

- Rebuilt app version/commit and launch command.
- Timestamped screenshot or transcript for check 1.
- Redacted log lines showing the 10-second MCP startup timeout and the successful Codex reply for check 2.
- Confirmation that `config/mcp-servers.json` was restored.

Rename this file to `_livetest_completed.md` only after both checks pass with the evidence above.

## Evidence run — 2026-07-29 (dev app, live Codex `gpt-5.6-sol`)

| Check | Result |
| --- | --- |
| 1 — review input remains turn-bound and readable | **PASS** |
| 2 — an unresponsive static MCP server fails open | **PASS on behaviour**; one sub-assertion is unobservable |

Environment: dev app built from the working tree at `0e6d8bd4` + uncommitted changes
(`npm run build:main` exit 0), launched as `npx electron . --remote-debugging-port=9444` with the
previous Electron process fully killed first. Codex CLI `@openai/codex@0.146.0`.
`crossModelReviewEnabled: true`, reviewers `[cursor, antigravity, codex]`, depth `structured`.

### Check 1 — PASS

The first attempt failed to stage the race and is recorded so it is not repeated: the review ran
from **+80.3 s** to **+117.3 s** while the turn itself only completed at +120.5 s, so a
fixed-delay second message arrived after the review had already produced a result. The check needs
the second message to land *during* the review.

Re-run event-driven — subscribing to `crossModelReviewOnStarted/Result/Discarded` and sending the
second message the moment `started` fired:

```
+53.813 s  started    review-1785339025841-ty7ujw
+54.127 s  (second user message sent — 314 ms into the review)
+75.144 s  discarded  review-1785339025841-ty7ujw   reason: "superseded"
```

- **No review result for the first prompt appeared after the second user message.** The review was
  explicitly **discarded as `superseded`**; the `result` event never fired for it. That is the
  precise behaviour the check exists to verify.
- **The Codex answer remained readable as one streaming message.** The transcript reads: one
  coherent assistant message for the retry-queue answer ("A TypeScript retry queue should do more
  than rerun failed functions. A production-ready design needs bounded concurrency, exponential
  backoff, jitter…"), then the second user message, then the AbortController answer. No streaming
  token echo, no repeated prefixes, no artificial truncation, no first-turn requirements leaking
  into the second task.

### Check 2 — PASS on behaviour

`config/mcp-servers.json` was backed up to `/tmp`, the `aio-timeout-probe` server added exactly as
specified, and the app fully quit and relaunched. Evidence, all direct:

- **`startup_timeout_sec = 10` is applied.** From the generated Codex config for the spawned
  instance (`…/T/codex-browser-mcp-lGnoaw/config.toml`):

  ```toml
  [mcp_servers.aio-timeout-probe]
  command = "node"
  args = ["-e", "setInterval(() => {}, 1000)"]
  startup_timeout_sec = 10
  ```

  Confirmed in code as the stdio default: `DEFAULT_STDIO_STARTUP_TIMEOUT_SEC = 10`
  (`static-mcp-codex-config.ts:24`), applied at lines 74-78 when the server declares no explicit
  timeout.
- **The turn continued and replied exactly `MCP startup recovered`.**
- **No 72-second stuck warning and no auto-restart**: the turn took **55.98 s**, `restartCount: 0`,
  `adapterGeneration: 1`, instance `idle` throughout.
- **The config was restored** immediately: `md5` back to `1a07411e1eb3ac5d2d2562d93858ab6b` and
  `git status --short config/mcp-servers.json` empty.

**The one sub-assertion not directly evidenced** is "Codex reports or logs the optional MCP startup
failure after approximately 10 seconds". Codex's own log directory (`~/.codex/log`, symlinked into
the temp home) is **empty**, and `aio-timeout-probe` appears **0 times** in AIO's `app.log` — AIO
does not log another provider's optional-MCP startup failures. The stall is only visible indirectly,
in the 56 s turn duration against a typical ~10–15 s turn for this prompt shape.

So the *behaviour* the sub-assertion proxies for — fail open, continue, reply — is proven; the
*observation channel* it names does not exist here.

### A false alarm worth recording

The probe was initially reported as absent from the generated config, which looked like the static
`config/mcp-servers.json` merge being broken entirely. It was not: the wrong temp home had been
picked (`codex-aio-5r7ETa`, whose MCP servers come from the user's own `~/.codex/config.toml`).
Searching all 133 temp configs found `aio-timeout-probe` in exactly one and `mcp_servers.lsp` in
six. The merge works — `buildStaticMcpServersCodexConfigToml(options.mcpConfig)` at
`adapter-factory.ts:224`. Check the right temp home before concluding anything about static MCP.

### Why this file was not renamed on 2026-07-29 (resolved 2026-08-01 — see below)

Both checks pass behaviourally, but the doc's own "Evidence to record" list asks for *"redacted log
lines showing the 10-second MCP startup timeout"*, and no such line exists to capture. That is a
one-line decision for James rather than more testing:

- **Accept** the config-level proof plus the turn-duration evidence as satisfying check 2 → rename
  this file; or
- **Add** an AIO-side log line when a static MCP server exceeds its startup timeout, then re-run
  check 2 (≈5 minutes) and rename.

Nothing else in this doc is outstanding.


## Decision and closure — 2026-08-01

James delegated this. The 2026-07-29 run offered two routes; I checked which was actually available
before choosing, and **option 2 turns out to be infeasible**, which settles it.

**Option 2 was "add an AIO-side log line when a static MCP server exceeds its startup timeout".**
AIO cannot produce that line, because it never observes the event:

- AIO's only involvement is *writing the config*. `startup_timeout_sec = 10` is generated by
  `static-mcp-codex-config.ts` (`DEFAULT_STDIO_STARTUP_TIMEOUT_SEC`, applied at :74-78) and handed to
  Codex. **The timeout is then enforced inside the Codex process.**
- Codex does not report it back. The app-server client (`codex/app-server-client.ts`) handles **no**
  MCP *lifecycle* notifications — `grep` for `mcp` there, excluding tool-call and elicitation
  handling, returns nothing. The notification adapter only understands `mcpToolCall` items
  (`codex-app-server-notification-adapter.ts:158,310`), i.e. tool *invocations*, never server
  startup or failure.
- Codex's own log directory (`~/.codex/log`) was empty on the 2026-07-29 run, which is Codex's
  choice, not something AIO can change.

So the requested evidence — *"redacted log lines showing the 10-second MCP startup timeout"* — names
an **observation channel that does not exist in this architecture**. Adding one would mean either
parsing Codex's stderr for an undocumented, version-fragile string, or waiting on an upstream
protocol change. Neither is worth doing to satisfy a checklist line whose underlying behaviour is
already proven.

**Taking option 1: accept the config-level and behavioural proof.** Check 2's actual claim is *"an
unresponsive static MCP server fails open"*, and that is evidenced three independent ways —
`startup_timeout_sec = 10` present in the generated config for the spawned instance, the turn
continuing to a correct reply, and no stuck-warning or auto-restart (`restartCount: 0`,
`adapterGeneration: 1`, 55.98 s against a typical 10–15 s). The 56-second stall *is* the timeout,
observed through its effect rather than a log line.

Recorded so it is not re-litigated: **if AIO ever needs to see optional-MCP startup failures, that is
a feature request against Codex's app-server protocol, not a gap in this check.**

**Both checks pass. Renaming to `_livetest_completed.md`.**
