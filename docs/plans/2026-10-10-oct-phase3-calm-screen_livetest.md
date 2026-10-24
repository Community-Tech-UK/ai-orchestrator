# Live tests — October Phase 3: a calmer, clearer screen

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. A pending or
> unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** `2026-10-10-oct-phase3-calm-screen_plan.md`

## Status — 2026-10-23 queue resume

Open: 21 · Closed: 0 · Failed: 0

These are unrun live checks, not reproduced defects. Current worker command evidence is in
the plan's 23 October resume notes and the worktree's `_scratch/phase3-resume-2026-10-23/` reports.
Headless component, protocol, persistence and policy checks run in-loop; they are not deferred here.
This resume reran worker checks only; no provider/OS/device live campaign was run and all 21 checks stay open.

**Prerequisites (all checks):**
- A rebuilt and restarted app from the queue branch (`npm run dev` or a packaged build
  containing the Phase 3 work). Use the current plan's command receipts for agent-run
  verification; the coordinator owns the full suite and independent completion gate.
  These checks cover the rebuilt Electron integration, real providers, OS integration
  and James's own phone. Do not validate an older running build as this worktree.
- **Windows PC checks** run on James's Windows PC (browser/PC rules apply: start through
  the Browser Gateway preflight).
- **Check 7 (macOS Dock badge)** and **check 12 (macOS notifications)** need the Mac
  and James's explicit OK for the current task. Check 6 is the Windows badge counterpart.
- Keep `claudeLivePermissionPrompts` **false by default**. Only a separately authorised
  live campaign should enable it for newly spawned test sessions; check 19's first four
  checks must pass before any follow-up changes its shipping default.
- The 20 October worker recorded a healthy/deliverable `windows-pc` preflight with no matching
  worktree dev-app tab. That is historical evidence, not current worker health. The 23 October
  resume used no browser or desktop; preflight `windows-pc` again before starting a live campaign.

## Check 1: "Second opinion" naming and result (step 1)

1. On the Windows PC, with automatic second opinions turned OFF, open a Codex session.
2. Ask for a second opinion from a reply's menu.
3. Confirm the session header pill reads "Second opinion: ✓" or "Second opinion: N
   concerns" (never "cross-model review", never a bare dash for a skipped review), and
   the panel's fix button names the provider ("Ask Codex to fix these").
4. Open Settings and confirm the tab reads "Second opinion".

**Expected:** the new name everywhere; the panel opens with "Show all" / "Raw review".
**Why deferred:** needs a live Codex session and a completed second-opinion turn.

## Check 2: One header row and the composer home (step 2)

1. On the Windows PC, open a busy Claude session and a Copilot session.
2. Confirm the header is ONE row (session name, folder, non-default chips, cost, second
   opinion pill, Session options, Open/Files/Git — no model/account/context ring, no
   Interrupt button).
3. Confirm the Copilot account badge sits beside the message box, the context ring button
   opens Context details (mouse AND keyboard), and Stop works while text is typed (Stop
   replaces Send when nothing is staged; a small Stop beside Send when text or the loop
   panel is staged).
4. In Context details, confirm "Compact now…" opens the compaction preview and "Where the
   context goes" appears only when usage exists.
5. Queue a model change from the composer while a turn runs; confirm the pending chip
   appears and cancelling it works.

**Expected:** the one-row header and composer behaviours above.
**Why deferred:** needs two live provider sessions and a running turn.

## Check 3: Auto-approve wording and receipt (step 3)

1. On the Windows PC, switch Auto-approve during a Claude turn.
2. Confirm the chip shows the queued arrow, the Session options menu says "Auto-approve:
   on/off" with its consequence line, and the plain transcript receipt ("Auto-approve is
   on: the agent now acts without asking.") appears once the turn ends.
3. Confirm the draft composer says "Auto-approve: off" and "Fast: off" (not "YOLO ON").

**Expected:** plain words, unchanged model text delivered to the CLI.
**Why deferred:** needs a live Claude turn.

## Check 4: The busy line says what it is thinking about (step 4)

1. On the Windows PC, run a Codex task that reasons for a while (for example "plan a
   refactor of X, then do step 1").
2. Confirm the busy row changes from a tool label to "Thinking · …" mid-turn, and the
   session-list row shows the same short line while busy (and nothing while idle).

**Expected:** headline from bold heading or first sentence; Codex gains the mid-turn line.
**Why deferred:** needs a live reasoning Codex turn.

## Check 5: One status strip above the message box (step 5)

1. On the Windows PC, run a session with tasks, a child session and a second opinion.
2. Confirm one strip above the message box shows the chips (Tasks open by default, the
   rest folded), and the header's second-opinion pill opens the panel INSIDE the strip
   (no sixth chip).
3. Confirm a permission card and a question card sit OUTSIDE the strip, and the strip
   renders nothing when it is empty.
4. Press Escape with a chip panel open: it closes and focus returns to the chip; Escape
   again on a busy session interrupts.

**Expected:** the "healthy is invisible" strip; approvals never fold away.
**Why deferred:** needs live sessions with tasks, children and a review result.

## Check 6: The "Needs you" place — count, strip and tabs (step 6)

1. On the Windows PC, start a Claude session that asks for permission and switch to
   another app (do not answer the prompt).
2. Confirm the Windows taskbar shows the red-dot overlay with the number in its
   description ("N things need you"); focus Harness and confirm it clears; answer the
   prompt and confirm the count drops.
3. Confirm the rail's first button reads "Needs you: N waiting" (or "nothing waiting"),
   opens the Workboard, and its count equals the Workboard's Needs-you lane count
   (cards + request rows).
4. Confirm the slim top strip says "'<session>' is waiting for your answer" or
   "N things are waiting for you · '<session>' wants permission to use <tool>", with
   "Go to it" (opens the session) and "See all" (opens /work). The old approval-digest
   and Plan Queue banners are gone.
5. In the session list, confirm the tabs read "Needs you · Working · Idle · All" with
   counts (zero counts hidden), a failed session counts under Needs you until it is
   opened, then drops.
6. Collapse a project that contains a waiting session: the header shows "Needs you:
   <session>" (with "+N" for more). Collapse a parent with waiting children: the row
   shows "1 child needs you" beside "+N".
7. Hover a session row's name block: a small card shows what it is waiting for (the
   prompt text) and "Step N of M: <step>" when the session has a to-do list (Codex
   sessions only).

**Expected:** one consistent count across rail, strip, tabs and (while unfocused) the
taskbar; older resolved loop items and older document reviews do NOT count.
**Why deferred:** needs a live permission prompt and a rebuilt app; the overlay is
Windows-only.

## Check 7: The macOS Dock badge (step 6) — James's Mac, James's OK

1. With James's explicit OK for this session, on the Mac: same steps as check 6 items 1–2.
2. Confirm the Dock icon shows the red number while Harness is in the background and
   clears when Harness is focused.

**Expected:** same count as the rail.
**Why deferred:** needs the Mac; the rule says Mac browser/desktop work only with
James's OK in the current task.

## Check 8: A loop decision the agent made for you (step 6, after B5 data)

1. Run a short real-provider loop whose agent applies a low-risk decision, producing
   an outstanding item of kind `decision-applied` with `firstSeenRound` set.
2. Confirm the Needs-you lane shows the "Decision applied, tell me if wrong" row with
   "Looks right" and "Undo", and "Looks right" resolves the item ("kept") while "Undo"
   queues the undo hint — the row leaves the count either way.

**Expected:** B5's own row (no second set of buttons) inside the lane.
**Why deferred:** needs a real loop run with a B5-shaped outstanding item.

## Check 9: Permission and question cards (step 11)

1. ACP buttons (11b): with an ACP provider session (opencode or Copilot) that asks
   permission, confirm the agent's own buttons appear with its own names, "Allow once"
   completes only that call, and an "Always allow" button (if the agent offers one) is
   the only way a lasting grant is made. "Yes" typed as a reply never picks an always
   option when a once option exists.
2. Timeout receipt (11c): leave an ACP permission ask unanswered for its 60-second
   window; confirm the countdown shows "expires in N min" / "expiring…", then a receipt
   card explains why the request ended without an answer, dismissable and gone after 10
   minutes. Stopping a turn with a Claude ask shows "Cancelled because the turn was
   stopped".
3. Deny note (11d): in a real ask-first session, refuse a shell call with a note and read
   Claude's next message (the note is the reason it sees). Refuse a Write outside the
   folder (refusal card) with a note and confirm it arrives as a normal message.
4. Saved decisions (11e): open Settings → Permissions → Rules, confirm the remembered
   decisions list labels the existing legacy rules, remove one, quit and reopen, and confirm it is
   still gone (read the file's rule count afterwards without printing it).
5. Harness's own status tools (11f): in an ask-first session, confirm the orchestrator
   and browser-gateway status tools (list_remote_nodes, list_settings, snapshot, …) run
   WITHOUT asking, while mutating tools still ask.

**Expected:** as above; all wording in plain English.
**Why deferred:** needs live ACP provider sessions and a real permissions file edit by
James's click (the Remove button).

## Check 10: Retrieved notes in real conversations (step 15)

1. Leave "memory notes on every message" OFF. Run a ten-turn real conversation with
   short continuations and topic changes, then a Plan Queue prompt and crash continuation.
2. Read retrieval log counts without exposing private note contents. Short continuations
   and machine-written messages add no repeated sections; new topics may add relevant notes.
3. Judge whether the notes selected for the new topics are useful. Confirm Wake says
   "Shown N times" and the context panel reports the actual injected count/token estimate.
4. Run real loops in two repositories and confirm lessons remain in their originating project.

**Expected:** retrieved notes only on new user messages on new topics; per-project lesson
scoping.
**Why deferred:** real retrieval relevance needs provider replies and James's judgement.
Origin routing, query cleanup, streaming use detection, deduplication, token caps, compaction
boundaries, rule persistence and project scoping are already covered by agent-run tests.

## Check 11: Notices and desktop alert routing (step 7, Windows)

1. In the rebuilt app, put Harness in the background and trigger an ask-first Claude
   permission request. Confirm its desktop alert names the session and tool, with no
   command, file contents or prompt body. Click it and confirm that session opens.
2. Trigger equivalent asks in two sessions; each alerts once. Answer one from another
   surface and confirm its notification resolves. Opening Notifications marks rows seen
   without falsely resolving a live problem.
3. Activate an app-update notice and disconnected-worker notice. One ordinary row shows
   with "1 more notice"; expanding shows both. A timed approval remains visible.
4. Cause a real helper-model failure/recovery. The Local AI chip appears only while the
   helpers are paused, then disappears. Critical tool-loop toasts clear on live resolution.

**Expected:** one ordinary notice row, decision exceptions, exact session routing and no
healthy Startup/Local AI chips. Toast folding, durations and lifecycle are tested headlessly.
**Why deferred:** OS notification delivery/clicks and real worker recovery need the rebuilt app.

## Check 12: macOS desktop notification click and sound (step 7)

1. With James's explicit permission to use the Mac in this task, repeat check 11's first
   two actions in the rebuilt Mac app, including the configured sound.
2. Click the delivered notification and confirm the correct session opens.

**Expected:** the same safe title and routing as Windows, with the configured sound.
**Why deferred:** macOS notification integration requires James's current-task Mac permission.

## Check 13: Provider stalls, interrupts and failure copy (step 8)

1. In a controlled live Claude turn, produce more than two minutes of silence. Confirm
   one honest "No output for…" notice describes the actual restart action. Repeat with
   ACP and confirm its liveness notice does not promise a different recovery.
2. Stop a Claude turn and a Codex turn. Confirm each divider is a sentence and its
   tooltip is reachable with keyboard focus. A failed tool stays visible in a collapsed group.
3. Open a genuinely failed automation run; plain failure text and raw Details both appear.

**Expected:** real-provider events use the tested plain-copy presenters without contradictory notices.
**Why deferred:** actual silent-provider recovery and provider interrupt timing need live turns.

## Check 14: Global palette, menus and Settings layout (steps 9–10)

1. In a fresh rebuilt app with no session selected, press Ctrl+K on Windows on Home,
   Costs & Usage and Settings. Search "discord" and "doctor"; Enter opens the correct page.
2. Open More tools, restart and confirm persistence. With the fold closed, navigate to
   Plugins through the palette and confirm the fold opens automatically.
3. Inspect Settings at narrow and wide widths: one navigation column, content and help,
   no leftover Control Center column. Leave and return; the other menu's fold is preserved.
4. Search discord, whatsapp, tailscale, quota, shortcut and vpn; Jump to scrolls to the
   real section. Open an old `#remote-nodes` link. Toggle the attach parent setting and
   confirm the dependent profile row's badge follows it.

**Expected:** readable responsive layout and keyboard navigation on the rebuilt application.
**Why deferred:** visual layout and app-restart persistence require a matching running Electron
build. Cold-boot keybindings, page labels, route/search targets and seeded component behavior
are verified headlessly; no local Mac browser is authorised.

## Check 15: Real Copilot credit ledger (step 12a)

1. Start a new local Copilot session on the rebuilt app and complete three turns.
2. Compare the session's displayed AI credits with its final `events.jsonl` checkpoint
   total using read-only, count-only inspection. Each Costs total rises by the same delta.
3. Restart/resume and complete another turn; previously booked checkpoints do not book again.
   A session on another machine explains that credits are unavailable; it invents no dollars.

**Expected:** actual provider credits, a recording-start footnote and no Copilot dollar claims.
**Why deferred:** requires real Copilot checkpoint files and rebuilt-app migration execution.
Temporary SQLite migration, parsing, restart seeding and idempotency tests run in-loop.

## Check 16: Real foreground/background helpers (step 12b)

1. Ask a Claude session to start one foreground and one background helper, using another
   model where available. Observe Task/Agent rows while running and after completion.
2. Confirm live tokens, tool count and duration settle; Session status and the unfolded
   Costs row include both models and an explicitly approximate helper share.
3. Reload the transcript: live helper text is absent as designed; durable cost totals remain.

**Expected:** live telemetry stays separate from durable billing and main-context occupancy.
**Why deferred:** real CLI helper events and provider pricing need the rebuilt app and provider.

## Check 17: Plan billing, quota and session card (step 13)

1. On a real Claude Max account, open Session status via `/status`, its palette action
   and Context details. Each opens the same selected-session dialog and closes Context details.
2. With Show cost OFF, confirm no dollars in the header, card, Costs page or copied text.
   With it ON, plan dollars say API-price equivalent. Copilot shows credits only.
3. Inspect the selected account's quota line near its real limit. It uses that account
   and model window; changing to an account with no snapshot does not borrow another quota.
4. Open Costs & Usage: live and ended session names open/select/preview correctly; unfolding
   shows model rows. Inspect narrow-width dialog layout and Escape/focus behavior.

**Expected:** plan-first rows, honest missing/stale data and consistent selected-session targeting.
**Why deferred:** account-specific provider snapshots and rebuilt-app visual integration are live;
all thresholds, hidden-dollar behavior, dispatch and headless dialog interactions are tested.

## Check 18: Claude measurement and a real cache expiry (step 14)

1. In an idle resident Claude session, open Where the context goes. Confirm "Measured by
   Claude" categories sum to its own total; compare with that same session's `/context`
   output using an authorised terminal workflow (never Computer Use on a terminal).
2. Exceed a context-advice threshold with real tool traffic. The suggestion uses the
   shared summary wording and Compact now opens the existing preview/action path.
3. Leave a Max session idle for 61+ minutes, then send one message. The cache row names
   "idle N min" and reports a priced rewrite. Successful compaction is expected, not waste.

**Expected:** installed-CLI measurements or an honest estimate fallback, and real timed cache behavior.
**Why deferred:** internal CLI payload compatibility and a provider's hour-long cache cannot
be established by seeded clocks; mapping, coalescing, price math and compaction tests run in-loop.

## Check 19: Live permission rollout checks 1–4 (step 16; default stays OFF)

**Prerequisite:** enable `claudeLivePermissionPrompts` only for this authorised campaign
through Harness's documented settings CLI, then spawn a new user-started resident Claude
session in ask-first mode. Do not edit James's settings/database from a script.
Read `docs/llm/AIO_MCP_CLI_REFERENCE.md` first; in the rebuilt instance's injected shell:

```bash
rtk proxy "$AIO_MCP" settings get claudeLivePermissionPrompts --json
rtk proxy "$AIO_MCP" settings set claudeLivePermissionPrompts true --json
rtk proxy "$AIO_MCP" settings get claudeLivePermissionPrompts --json
```

Verify the readback is true. These commands are campaign instructions, not commands run
by this implementation worker. Do not print the injected socket or instance credentials.

1. Confirm the installed Claude accepts `--permission-prompt-tool stdio` with stream JSON.
   A real request produces one card; inspect only the redacted first-request debug receipt.
2. Ask for WebFetch, a connector call and Write outside the folder. Allow once completes
   each call without a restart; repeating the identical call asks again. Session/Always
   choices stop later matching asks, while Don't allow continues with a refusal and no duplicate card.
3. Press Stop with a card showing. It withdraws with the cancellation receipt and returns
   to idle. Starting another turn does not leave an orphaned request.
4. Trigger AskUserQuestion. One question card appears, no permission card, and the reply
   reaches Claude. Auto-approve and machine-started sessions retain their prior behavior.

**Expected:** all four checks pass on the installed binary before a separate default-flip change.
**Why deferred:** real installed-Claude control-protocol acceptance is external runtime evidence.
Broker, adapter stdout/exit, gate, rule scope, cancellation and request-ID paths are tested in-loop.

## Check 20: Phone answers, long waits and borrowed loops (step 16)

1. With check 19's opt-in test session, answer a live ask from the phone. It completes
   that exact request without restart. If already configured, repeat via the thin client
   and channel bridge without sending unsolicited messages or setting up new integrations.
2. Leave an ask unanswered for 25 minutes. No stall notice/restart occurs; answer it normally.
3. Start a loop borrowing that session and make a round request a web fetch. It is refused
   immediately, without a card or a hung round.
4. Switch the opt-in OFF through the authorised settings CLI and spawn a new session;
   the existing held/refusal behavior returns. Leave the shipping default false.

```bash
rtk proxy "$AIO_MCP" settings set claudeLivePermissionPrompts false --json
rtk proxy "$AIO_MCP" settings get claudeLivePermissionPrompts --json
```

**Expected:** exact request targeting and no unattended or watchdog hang.
**Why deferred:** requires real phone/provider/loop execution and a 25-minute live wait;
the corresponding time, race and loan guards already have deterministic tests.

## Check 21: Phone labels and optional Swift compatibility (step 17)

1. Keep an old installed phone build connected to the new desktop. Background it and
   trigger a question: the existing Live Activity still updates, with the `waiting`
   orange color key. Observe updates for at least a minute.
2. When James authorises rebuilding/reinstalling his phone app, install the new native
   build. Repeat: the lock screen says "Needs your answer", an approval says "Needs
   your approval", and colors continue to follow the unchanged coarse keys.
3. Confirm the phone app's own session/project labels match the desktop, and older
   payloads without `label` still render through the native status fallback.

Follow `docs/iphone18-harness-sideload-status.md` and the iOS testing skill for the
device build/install; do not infer signing, device selection or release authority.

**Expected:** compatible old/new payloads and distinct visible question/approval wording.
**Why deferred:** a real device, signing/reinstall and APNs/Live Activity delivery require
James's phone. The TypeScript parity tests and Swift widget simulator-SDK typecheck run
in-loop; the full native app/plugin and physical lock screen remain unverified.

