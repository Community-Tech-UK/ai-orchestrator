# Live test — Discord bot mobile-parity

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Prerequisites: **rebuild the app** (`npm run build`) and restart the AIO instance running the Discord bot, with a paired Discord account. These checks drive the real Discord gateway (buttons, reactions, file uploads, DM notifications) and cannot run in-loop. Plan: `2026-07-23-discord-bot-parity_plan_completed.md`.

Rename this file to `2026-07-23-discord-bot-parity_livetest_completed.md` only when every check passes with evidence.

## Status — completed 2026-09-27

Open: 0 · Closed: 0 · Transferred: 10 · Failed: 0

Every remaining check needs James (or another identity he explicitly pairs) to send an inbound
Discord message and then click/read live Discord controls. The complete campaign has therefore been
moved to [RES-008](2026-09-27-livetest-human-external-residuals_livetest.md#res-008--discord-bot-mobile-parity-campaign).

## Closed checks

None yet.

## Why every check is deferred (mechanism)

Confirmed repeatedly (2026-08-01, 2026-08-18, 2026-08-19, 2026-08-24 — unchanged each time,
consolidated here):

- **Prerequisites are already met.** The bot token lives in SQLite
  (`ChannelCredentialStore`, `src/main/channels/channel-credential-store.ts` →
  `channel_credentials` table, `platform = "discord"`), not in `settings.json` (an earlier
  2026-07-29 run searched the wrong place and wrongly reported "no bot configured" — that verdict
  is superseded). The bot is live: `app.log` shows repeated fresh `Connected to Discord` /
  `botUsername: "Orchestrator Bot#1070"` / `Discord slash commands registered {count: 21}` cycles,
  most recently re-confirmed 2026-08-24, with `restoredSenders: 1` (one paired account).
- **No check can be agent-driven**, precisely because every inbound Discord message is gated by a
  per-platform sender allow-list: `ChannelAdapter.isSenderAllowed()`
  (`src/main/channels/channel-adapter.ts:107`) checks
  `this.accessPolicy.allowedSenders.includes(senderId)`, backed by
  `ChannelAccessPolicyStore` (`channel-access-policy-store.ts`). A message from any other Discord
  account either goes nowhere or triggers a separate `handlePairingRequest()` flow that itself
  needs a human to approve. `channelSendMessage` (the app's outbound API) cannot simulate an
  inbound message. Source last touched 2026-08-01 (`95590c27`), confirmed unchanged through
  2026-08-24.
- **A second-identity workaround was assessed and rejected** (2026-08-18): it only relocates where
  James is needed (approving the new pairing), the checks are inherently multi-turn and
  human-paced (click Approve, wait 👀→✅, read an attachment, watch for a ~30s heartbeat), and no
  Discord test-account credentials were found for this purpose. No message has been posted to
  Discord, real or test, in any of these evidence runs.

## Residual transferred on 2026-09-27

The production log freshly confirms that the bot itself is available: at 03:58 BST the
`DiscordAdapter` connected as the configured bot and registered 21 slash commands. That does not
exercise any inbound behavior because the sender allow-list cannot be simulated from the app's
outbound API. No Discord message was sent during this campaign.

[RES-008](2026-09-27-livetest-human-external-residuals_livetest.md#res-008--discord-bot-mobile-parity-campaign)
now owns all ten checks, including the original one-sitting order, expected observables and settings
cleanup. No defect was reproduced, so no remediation-register entry was added.
