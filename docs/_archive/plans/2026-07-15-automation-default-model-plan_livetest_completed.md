# Automation Default Model — Live Test

**Plan:** `2026-07-15-automation-default-model-plan_completed.md`
**Prerequisites:** rebuilt + restarted Harness app (renderer settings UI + main-process runner
changes are compiled in). Use the primary local instance.

All code, unit/integration tests, lint, and LOC gates already pass in-loop. The checks below
are deferred only because they need the running app and a real automation spawn — they cannot
be exercised by unit tests, the CLI, or renderer store seeding alone.

---

## Check 1 — Setting persists and survives a chat model switch

Steps:
1. Open **Settings → General**. Find the new **"Default automation model"** card (below
   "Default provider and model").
2. Click **Pinned**, choose e.g. **Claude · Opus latest, 1M**.
3. In a separate Claude chat, open the model picker and select **Fable 5**.
4. Return to **Settings → General**.

Expected:
- The "Default automation model" card still shows **Claude · Opus latest, 1M** (unchanged by
  the Fable selection). Contrast: the "Default provider and model" card above WILL now show Fable.
- Programmatic confirmation: `$AIO_MCP settings get automationDefaultModel` returns the pinned
  model id, and `defaultModelByProvider.claude` is `claude-fable-5` — proving the two are decoupled.

## Check 2 — Auto automation spawns on the configured default

Steps:
1. With the default set to Claude · Opus (from Check 1), ensure an automation exists whose Model
   is **Auto** (e.g. "Tender Radar daily run" or a throwaway test automation).
2. Trigger it (Run now, or `$AIO_MCP`/UI fire).
3. Tail `~/Library/Application Support/harness/logs/app.log`.

Expected (verbatim shape to grep for):
- A `"Creating instance"` line with `displayName` `"Automation: <name>"`, immediately followed by
  `"Resolved model for instance"` whose `data` has **`"configOverride":"<the pinned model>"`** and
  `"resolved":"<the pinned model>"`.
- Critically, `resolved` is the **pinned default**, NOT `defaultModelByProvider.claude`
  (`claude-fable-5`). Before this feature the Auto line had no `configOverride` and resolved to
  the leaked value — its presence now is the proof the default is applied.

## Check 3 — Unset default = documented fallthrough (regression guard)

Steps:
1. Set the "Default automation model" card back to **Auto** (clears both dedicated keys).
2. Fire the same Auto automation and tail the log.

Expected:
- The `"Resolved model for instance"` line has **no `configOverride`** and `resolved` equals
  `defaultModelByProvider.<provider>` (the last-used model), matching the pre-feature behaviour —
  confirming an empty default is fully backwards compatible.

---

Rename this file to `..._livetest_completed.md` only when all three checks pass, pasting the
relevant `app.log` lines as evidence under each check.

---

## Evidence — 2026-07-16 (all three checks PASS)

**Environment / method.** Run against the primary live installed app (`/Applications/Harness.app`,
main PID confirmed running) — not a dev copy. All steps were driven programmatically through the
live app, as the task requires (no GUI clicks):

- Settings get/set/reset via the bundled `aio-mcp settings …` CLI
  (`/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp`), authenticated against the
  running parent through the live orchestrator-tools socket + instance id.
- Automations created/deleted via the `create_automation` / `delete_automation` tools on the
  `aio-mcp orchestrator-tools` stdio MCP forwarder, and fired by their own one-time `runAt`
  schedule (a real scheduler-driven spawn, not a synthetic call).
- The "switch a Claude chat to Fable 5" step was reproduced programmatically by writing
  `defaultModelByProvider.claude = "claude-fable-5"` — the exact key the interactive picker
  rewrites (`provider-state.service.ts`), which is the leak this feature guards against.

Throwaway automations only (`LiveTest ADM Check2` / `LiveTest ADM Check3`, prompt = print "ok",
workingDirectory `/tmp`); both deleted afterwards (`deleted:true`, no lingering runs). Original
settings restored at the end (see Restore below).

### Check 1 — Setting persists and survives a chat model switch — **PASS**

Pinned automation default to Claude · Opus 1M, then simulated the interactive Fable-5 selection.
Programmatic confirmation (the decoupling proof called for in the check):

```
automationDefaultModel     = "opus[1m]"          # unchanged by the Fable switch
automationDefaultCli       = "claude"
defaultModelByProvider.claude = "claude-fable-5"  # the interactive last-used value moved to Fable
```

`automationDefaultModel` did not track `defaultModelByProvider.claude` → the two keys are decoupled.

### Check 2 — Auto automation spawns on the configured default — **PASS**

With the pinned default (`opus[1m]`) set and the leak at `claude-fable-5`, an Auto-model
automation was fired. Actual `app.log` lines:

```
{"timestamp":1784228697005,"level":"info","subsystem":"InstanceLifecycle","message":"Creating instance","data":{"displayName":"Automation: LiveTest ADM Check2","resume":false,"workingDirectory":"/tmp","initialPromptLength":127,"initialPromptPreview":"This is an automated live-test spawn. Output exactly the word: ok and then stop. Do not use any tools or take any other action.","initialContextBlockLength":0,"modelOverride":"opus[1m]","provider":"claude","hasContextInheritanceOverride":false,"forceNodeId":null,"hasNodePlacement":false}}
{"timestamp":1784228701828,"level":"info","subsystem":"InstanceLifecycle","message":"Resolved model for instance","data":{"configOverride":"opus[1m]","perProviderRemembered":"claude-fable-5","settingsDefault":"opus","resolved":"opus[1m]"}}
```

`configOverride` is present and `resolved` is the **pinned default `opus[1m]`**, NOT the leaked
`perProviderRemembered:"claude-fable-5"`. This is the proof the automation default is applied.

### Check 3 — Unset default = documented fallthrough (regression guard) — **PASS**

Both dedicated keys reset to Auto (`automationDefaultModel=""`, `automationDefaultCli="auto"`),
leak still at `claude-fable-5`, same Auto automation fired. Actual `app.log` lines:

```
{"timestamp":1784228808002,"level":"info","subsystem":"InstanceLifecycle","message":"Creating instance","data":{"displayName":"Automation: LiveTest ADM Check3","resume":false,"workingDirectory":"/tmp","initialPromptLength":127,"initialPromptPreview":"This is an automated live-test spawn. Output exactly the word: ok and then stop. Do not use any tools or take any other action.","initialContextBlockLength":0,"provider":"claude","hasContextInheritanceOverride":false,"forceNodeId":null,"hasNodePlacement":false}}
{"timestamp":1784228814802,"level":"info","subsystem":"InstanceLifecycle","message":"Resolved model for instance","data":{"perProviderRemembered":"claude-fable-5","settingsDefault":"opus","resolved":"claude-fable-5"}}
```

`Creating instance` has **no `modelOverride`**, and `Resolved model` has **no `configOverride`**
with `resolved` == `defaultModelByProvider.claude` (`claude-fable-5`) — identical to the
pre-feature behaviour. An empty default is fully backwards compatible.

### Restore

Settings returned to their pre-test values (verified via `aio-mcp settings get`):
`automationDefaultModel=""`, `automationDefaultCli="auto"`,
`defaultModelByProvider.claude="opus[1m]"` (full object restored),
`defaultModel="opus"` and `defaultCli="auto"` untouched. Throwaway automations deleted.
