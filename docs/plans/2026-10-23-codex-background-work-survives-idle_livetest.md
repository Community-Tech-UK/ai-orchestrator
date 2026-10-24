# Codex background commands: rebuilt-session live checks

> **If a defect is reproduced:** read [the campaign runbook](livetest-campaign-runbook.md), add a new LT-NNN item (index and full acceptance record) to [the remediation register](livetest-remediation-register.md), and add matching implementation status to [the active remediation follow-up](2026-07-19-livetest-failure-remediation-followup_plan.md). If that plan is closed, reopen it or create an active follow-up before adding content. Keep per-check evidence here.

Plan: [Codex background work survives idle](2026-10-23-codex-background-work-survives-idle_plan_completed.md)

Status: pending. All six implementation parts, canonical automated checks, the full suite and fresh independent completion review passed. Source-level, compiled-build, timer, continuation, transcript and Angular-render checks ran separately; the five observations below still require a newly started Harness main process plus real provider turns.

## Prerequisites and reason for deferral

Start a normal authorised development or installed build containing the changes, without interrupting existing work. This implementation task does not restart James's running Harness, alter his idle setting, or resume his drive copy. The five checks below require a live Codex provider session and observation of its on-screen transcript; Harness is a prohibited desktop-control target. They must run in an authorised live-test campaign or with James observing. No local Mac browser may be opened; any browser step must preflight and explicitly target `windows-pc` through Browser Gateway.

Use a disposable working directory and benign timer commands only. Record the existing “Close idle agents after” value; temporarily set it to one minute for checks 1–2 and restore it afterwards. Use a non-hardened local Codex session in app-server mode, with no active loop or thread goal. The exec fallback does not have persistent background terminals.

## Check 1: work survives the idle threshold and appears on screen

1. Ask Codex to start its own background command equivalent to `rtk proxy node -e 'setTimeout(() => console.log("Background check complete"), 300000)'`, yield until it has a background-terminal identifier, then end its turn. Do not use Claude MCP Bash, Monitor, scheduling tools or a native goal.
2. Observe the session after the turn ends and again after more than one minute.
3. Inspect the session list indicator and confirm the command remains alive.

Expected: the session stays awake past the idle threshold and shows one background task. With the current shared indicator the wording is “Waiting on 1 background task”; count and provider-neutral rendering have automated coverage. No hibernation/kill is logged for this live command.

Evidence: pending.

## Check 2: completion wakes the agent without another user message

1. Leave the same session alone until the five-minute command exits.
2. Record the command completion time, automatic continuation time, command output read and assistant reply.
3. The real CLI smoke already observed `item/completed` outside a turn and no automatic provider turn. In this campaign, confirm the integrated Harness continuation still produces one reply; the one-minute terminal poll remains the fallback.

Expected: within about sixty seconds of exit, Harness asks Codex to inspect the command output and continue. The agent reads “Background check complete” and replies without user input. One exit produces one continuation, with the command detail in the internal wake prompt.

Component evidence: `_scratch/codex-background-live-provider-probe.log` verifies real GPT6.1-Sol native command tracking and completion outside a turn in an isolated CLI thread. Integrated Harness/UI evidence remains pending.

## Check 3: one check-in for long-running silent work

1. Start a native background timer command that lasts at least twelve minutes and end the turn. Keep the session otherwise silent; no thread goal or live loop.
2. Observe the session through the ten-minute silent point, then another two minutes. Stop the benign timer afterwards.

Expected: exactly one automatic check-in asks the agent to check output/progress; the one-minute list polls do not postpone it and do not cause repeating check-ins for the unchanged work set.

Evidence: pending.

## Check 4: deliberate close records stopped work

1. In a fresh session start another benign five-minute native background command, end its turn and wait for the background indicator.
2. Close that session by hand. Inspect its retained/archive transcript.

Expected: one plain transcript line says closing the session also stopped one background command and identifies that command. The application log records the stopped-command count. No completion continuation is dispatched during shutdown.

Evidence: pending.

## Check 5: Claude callback tools are absent in an actual Harness Codex session

1. Start a fresh Harness Codex session whose generated configuration includes a Claude CLI `mcp serve` server from the user's config.
2. Inspect that session's discovered tools (do not invoke callback tools).

Expected: Monitor, ScheduleWakeup, CronCreate, CronDelete, CronList, RemoteTrigger, Workflow, PushNotification, SendMessage, ListAgents and TaskStop are absent on that server; other allowed tools remain. The user's own Codex configuration file is unchanged. A no-inference isolated Codex 0.164.0 probe already confirmed strict-config acceptance and actual filtering; this check confirms the live Harness session sees its generated home.

Evidence: pending.

## Remaining limitation

Claude MCP Bash with `run_in_background` can still hide commands in a separate Claude process. The Codex prompt directs native commands; this change deliberately preserves the user's other MCP tools and servers.
