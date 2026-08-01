# Fable WS1 live-provider fixture recording

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Prerequisites:** a rebuilt/restarted Harness app, an authenticated local CLI for the provider being recorded, and a disposable workspace with no sensitive project material. This validates the final external step deferred from [Fable WS1](2026-07-13-fable-implementation-plan_completed.md#ws1--provider-event-fidelity--fixture-replay-harness): real provider CLI output cannot be generated safely in automated unit tests.

## Record one fixture

1. Start the rebuilt app with `npm run dev` and create an instance in the disposable workspace for the intended provider.
2. Send a short canned prompt that creates the requested scenario (for example, a plain answer for `basic-conversation`, or a read-only shell command for `tool-use-bash`). Wait for the instance to settle.
3. Locate the app's conversation-ledger SQLite database in its user-data directory. Do not copy its contents into the repository.
4. Run the capture command against that database and the instance ID:

   ```bash
   npx tsx scripts/capture-provider-fixture.ts \
     --db <conversation-ledger.db> \
     --instance <instance-id> \
     --scenario <scenario>
   ```

5. Inspect the generated JSONL under `packages/contracts/src/__fixtures__/provider-events/<provider>/`. Confirm it contains only redacted data, no workspace paths, credentials, personal text, or provider session IDs. Delete and re-record if it does not.
6. Run the replay proof:

   ```bash
   npm run test:quiet -- src/main/providers/__tests__/parity/fixture-replay.spec.ts
   ```

   Expected: the newly recorded provider/scenario test passes with its golden canonical event stream.

## Completion matrix

Record and replay these six sanitized cases:

- Claude: `basic-conversation`, `tool-use-bash`
- Codex: `basic-conversation`, `tool-use-bash`
- Antigravity: `basic-conversation` (the live Google-backed provider; `gemini` is retained only as
  a deprecated back-compat fixture for persisted historical data — see `BuiltInProviderName` in
  `packages/contracts/src/types/provider-runtime-events.ts`. Do not treat a missing `gemini`
  executable as a blocker for this row.)
- Copilot: `basic-conversation`

Rename this file to `_livetest_completed.md` only after all six rows have current passing evidence. The Fable implementation plan remains active because later workstreams are intentionally out of scope for WS1.

## Evidence run — 2026-07-16 (BLOCKED, no rows recorded)

An automated attempt to record and replay the six rows could not execute in this
session. The environment permits read-only filesystem inspection only; every
process-execution command required an approval that cannot be granted in a
non-interactive run.

**Blockers observed (verified this session):**

- `node -e ...`, `sqlite3 ...`, `git ...`, and `command -v ...` all returned
  "requires approval" and did not run. Consequently none of the required steps
  are runnable here: `npm run dev` (rebuilt app), `npx tsx
  scripts/capture-provider-fixture.ts` (capture), `sqlite3` against the ledger
  DB, and `npm run test:quiet -- ...fixture-replay.spec.ts` (replay proof) are
  all blocked.
- Driving the Electron GUI (create instance in a disposable workspace, send the
  canned prompt, wait for settle) additionally requires interactive/automation
  access not available in this non-interactive session.
- Provider CLIs: `which gemini` → **not found** (Gemini CLI not installed on this
  machine, so the Gemini `basic-conversation` row is unrecordable here even
  interactively until it is installed and authenticated). `claude`, `codex`, and
  `copilot` resolve to ccusage wrapper shell functions (underlying CLIs present),
  but their authentication could not be verified because CLI execution is blocked.

**State confirmed via read-only inspection:**

- The dev app ledger DB exists at
  `~/Library/Application Support/harness-dev/conversation-ledger/conversation-ledger.db`.
- All six fixture pairs already exist under
  `packages/contracts/src/__fixtures__/provider-events/{claude,codex,gemini,copilot}/`.
  However, the inspected files (`claude/tool-use-bash.jsonl`,
  `codex/tool-use-bash.jsonl`) contain literal identifiers, commands, and paths
  (`claude-tool-1`, `git status --short`, `/workspace`) that
  `scripts/capture-provider-fixture.ts` would have rewritten to `<redacted-id>` /
  `[omitted-session-body]` / `<redacted-path>`. They appear to be hand-authored
  placeholders rather than sanitized live-provider captures — i.e. the live
  recording this doc defers is still genuinely outstanding.

**Completion matrix status after this run:**

| Row | Result |
| --- | --- |
| Claude · basic-conversation | Not recorded — execution blocked |
| Claude · tool-use-bash | Not recorded — execution blocked |
| Codex · basic-conversation | Not recorded — execution blocked |
| Codex · tool-use-bash | Not recorded — execution blocked |
| Gemini · basic-conversation | Skipped — Gemini CLI not installed; also execution blocked |
| Copilot · basic-conversation | Not recorded — execution blocked |

No rows passed. File intentionally **not** renamed to `_livetest_completed.md`.
Re-run in an interactive session (or one that permits `node`/`npm`/`npx`/`sqlite3`
and launching the Electron dev app), with the Gemini CLI installed and all four
provider CLIs authenticated.

## 2026-07-19 Current Note (LT-006 / LT-007 in `docs/plans/livetest-remediation-register.md`)

Two updates to the 2026-07-16 evidence above, preserved as-is for its date:

1. **Provider row (LT-006):** the completion matrix's Gemini row is superseded — record
   `antigravity`/`basic-conversation` instead (see the updated Completion Matrix above). A missing
   `gemini` executable is no longer a blocker for this checklist; it never was for antigravity,
   which is the live successor.
2. **"No GUI automation" blocker (LT-007) — corrected:** the 2026-07-16 run's statement that
   "driving the Electron GUI... requires interactive/automation access not available in this
   non-interactive session" is preserved as an accurate record of that attempt. An earlier version
   of this note claimed "Computer Use tools are now available in this environment" — that was
   checked and found **false** for this session; it should not have been stated without verifying
   first. The underlying `npm run dev` / `npx tsx scripts/capture-provider-fixture.ts` / `sqlite3` /
   `npm run test:quiet` commands were never actually blocked (ordinary shell commands, confirmed by
   directly using them elsewhere this session). What genuinely still requires either a human or a
   real, currently-authenticated provider CLI session — which this session does not have and
   should not fabricate by spending real provider credentials without being asked — is step 2:
   creating an instance and sending a real canned prompt to each live provider. A rebuilt dev
   Electron instance CAN be scripted via `puppeteer-core` over its `--remote-debugging-port` (no
   Computer Use needed — demonstrated in `2026-07-13-doc-review-choice-controls-plan_livetest.md`'s
   2026-07-19 evidence), but that only drives the app's own UI/IPC; it does not substitute for a
   real authenticated Claude/Codex/Antigravity/Copilot conversation turn.

Re-running this checklist still requires: a rebuilt/restarted app, a disposable workspace, and
each provider CLI (Claude, Codex, Antigravity, Copilot) authenticated on the machine that runs it
— genuine external prerequisites, not an automation-capability gap.

## Evidence run — 2026-07-26 (5 of 6 rows recorded live; copilot blocked on provider quota)

Run against the **packaged app** (`/Applications/Harness.app`, `app.asar` packaged 2026-07-25 15:07,
main process started 2026-07-25 15:22), not the dev app. Real sessions were created by scheduling
one-time Harness **automations** (`create_automation`, provider pinned per row) into the disposable
workspace `/tmp/aio-lt-ws1`, each carrying a canned prompt — this is the "create an instance and
send a real canned prompt" step the 2026-07-19 note said still needed a human. It does not.

Fixtures were captured from the packaged app's ledger
(`~/Library/Application Support/harness/conversation-ledger/conversation-ledger.db`) with the
documented command. **Tooling note for the next runner:** `npx tsx scripts/capture-provider-fixture.ts`
fails with `ERR_DLOPEN_FAILED` because `better-sqlite3` in this tree is built for Electron's ABI,
not Node's. Run it under Electron's node instead (do **not** rebuild the module — that breaks
`npm run dev`):

```bash
ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/tsx/dist/cli.mjs \
  scripts/capture-provider-fixture.ts --db "<ledger.db>" --instance <id> --scenario <scenario>
```

| Row | Result |
| --- | --- |
| Claude · basic-conversation | ✅ Recorded (instance `cnu8sdn5c`, 02:02Z) |
| Claude · tool-use-bash | ✅ Recorded (instance `c56exq3vy`, 02:05Z) |
| Codex · basic-conversation | ✅ Recorded (instance `xiauwffm8`, 02:08Z) |
| Codex · tool-use-bash | ✅ Recorded (instance `xuc2ys063`, 02:11Z) |
| Antigravity · basic-conversation | ✅ Recorded (instance `ivw7b7p46`, 02:17Z) |
| Copilot · basic-conversation | ⛔ **Blocked — provider monthly quota exhausted** |

**Step 5 (sanitization) — verified.** Every recorded row contains only `<redacted-id>`,
`<redacted-path>` and `[omitted-session-body]` in place of free-form content; no workspace paths,
credentials, personal text or provider session ids survive. Numeric fields kept by design are
process ids in `spawned`, and token/percentage counters in `context`/`complete` usage.

**Step 6 (replay proof) — PASS.** `npm run test:quiet -- src/main/providers/__tests__/parity/fixture-replay.spec.ts`
→ `✓ 1 files · 7 tests passed`, re-run green after each newly recorded row.

**Copilot blocker (external, not tooling).** The scheduled copilot session spawned and completed
normally, but its assistant turn was the provider's own error string —
`Error: You have exceeded your monthly quota (Request ID: CFB4:…)` — i.e. the throttled-CLI
"provider notice returned as content" case. Confirmed account-wide by an independent probe through
the copilot CLI (`copilot_chat` → same `You have exceeded your monthly quota`). That turn was
deliberately **not** recorded as `copilot/basic-conversation`: its event *shape* is a valid ACP
stream, but the scenario means "a plain answer", and recording an error turn under that name would
misrepresent the golden stream. The pre-existing hand-authored copilot placeholder is left in place.
Re-record this single row once the copilot quota resets.

**Fidelity finding — the hand-authored placeholders encoded the wrong shape.** Real captures show
Claude and Codex never emit dedicated `tool_use` / `tool_result` *adapter events* at all; across the
whole 1.9M-row capture history only the ACP-backed providers (`cursor`, `grok`) do. Claude and Codex
express tool activity as `output` events whose payload carries `type: "tool_use"` /
`type: "tool_result"`. The old placeholders modelled them as top-level `tool_use`/`tool_result`
events, which no Claude or Codex session has ever produced. Also observed: the real Claude
`tool-use-bash` stream contains the `tool_use` output but **no** `tool_result` output, while Codex
emits both.

**Status: NOT renamed.** 5 of 6 rows have current passing evidence; the copilot row is blocked on an
external provider quota.

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

Five of six provider fixtures were recorded live on 2026-07-26; only the copilot row is missing, and it was blocked on provider quota. Copilot is installed and working (a Copilot instance ran fine today for WS14), so **this is likely a single short run away from complete** — the most nearly-done doc in the backlog.

## Evidence run — 2026-07-31 — **copilot row recorded; 6 of 6 complete**

The 2026-07-26 blocker was external and is gone: Copilot's monthly quota has reset. Recorded against
the **dev app** (rebuilt main, `--remote-debugging-port=9444`), ledger
`~/Library/Application Support/harness-dev/conversation-ledger/conversation-ledger.db`.

- Instance `pxzwzboqd`, provider `copilot`, model `gemini-3.1-pro-preview`, disposable workspace
  `/tmp/aio-lt-ws1b`.
- Canned prompt: *"What is the capital of France? Answer in one short sentence. Do not use any
  tools."*
- Assistant turn: **`Paris is the capital of France.`** — a genuine plain answer, **not** the
  provider's quota-error string. That distinction is the whole reason the previous run refused to
  record this row, so it was checked explicitly (`/exceeded your monthly quota|rate limit/i` → no
  match) before capturing.

Captured with the documented Electron-node invocation (the `ERR_DLOPEN_FAILED` note above still
applies):

```bash
ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/tsx/dist/cli.mjs \
  scripts/capture-provider-fixture.ts --db "<harness-dev ledger>" \
  --instance pxzwzboqd --scenario basic-conversation
```

**Step 5 (sanitization) — verified.** The regenerated
`copilot/basic-conversation.jsonl` + `.golden.jsonl` contain only `<redacted-id>` and
`[omitted-session-body]`; the retained numerics are the spawn pid and a `duration` counter. A leak
scan for `suas`, `/Users/`, `/tmp/aio`, `sk-`, `ghp_` **and the answer text itself** (`Paris`)
returned **0** matches — the model's words do not survive into the fixture, which is the point.
This replaces the hand-authored placeholder with a real recorded stream.

**Step 6 (replay proof) — PASS.** `npm run test:quiet -- src/main/providers/__tests__/parity/fixture-replay.spec.ts`
→ `✓ 1 files · 7 tests passed`.

| Row | Result |
| --- | --- |
| Claude · basic-conversation | ✅ 2026-07-26 |
| Claude · tool-use-bash | ✅ 2026-07-26 |
| Codex · basic-conversation | ✅ 2026-07-26 |
| Codex · tool-use-bash | ✅ 2026-07-26 |
| Antigravity · basic-conversation | ✅ 2026-07-26 |
| Copilot · basic-conversation | ✅ **2026-07-31** |

**All six rows have current passing evidence. Renamed `_livetest_completed.md`.**
