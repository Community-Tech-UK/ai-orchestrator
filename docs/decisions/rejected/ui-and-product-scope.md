# Ui and product scope

Source: October 10 and October 20 research lists (`claude_oct-todo.md`, “Previously rejected” and “Considered and rejected”; `claude_oct-2-todo.md`, AppendixC). These are recorded stances, not new measurements. Reopening needs the condition below, not another unscoped sweep.

## LLM follow-up suggestions, composer predictions and autocomplete

- Stance: Rejected.
- Reason: They add a hidden model call over context for every reply; Codex removed follow-up suggestions within three days.
- Reopen when: An opt-in trial demonstrates a concrete benefit at an accepted measured cost.
- Not covered: the session watcher (`src/main/session-watcher/`), which James asked for on 14 November 2026. It is off by default and makes one short call per finished turn of his own Claude chat sessions to Claude's fast model, to decide whether the agent can carry on or he is needed. It suggests nothing to the person. The trial and its measured cost and accuracy are in `docs/plans/2026-11-14-session-watcher_history.md`.

## Idle nudges and first-run welcome wizards

- Stance: Rejected.
- Reason: Repeated upstream attempts were removed; no current measured need justifies the interruption.
- Reopen when: Observed usability failures and user research justify a targeted flow.
- Not covered: Agent-facing waiting check-ins (`src/main/instance/instance-waiting-check-in.ts`), which James approved on 6 November 2026. They prompt the agent, not a person, and only when a turn ends waiting on work with nothing to wake it. Observed failure: Claude stopped on two things that could never notify it, and sat idle for 13 minutes.
- Not covered: the session watcher's automatic "carry on" (`src/main/session-watcher/`), asked for by James on 14 November 2026. It prompts the agent, not the person, and only when a small model and code checks agree the next step is safe; everything else is shown to him as a question. Measured need: one in ten of his typed messages in a month was a bare "continue" or "yes".

## OpenCode tooltip component

- Stance: Rejected.
- Reason: Harness already has the stronger tooltip implementation.
- Reopen when: A specific accessibility or interaction gap survives improvements to the existing component.

## Bare question-mark shortcut overlay

- Stance: Rejected.
- Reason: The command palette already displays live bindings.
- Reopen when: A measured discoverability problem cannot be solved in the existing palette.

## t 3 code zero-native-title lint shape

- Stance: Rejected.
- Reason: Its own truncation component leaks title attributes; Harness’s parser-based ratchet is stricter.
- Reopen when: A replacement catches at least all existing ratchet cases and adds verified coverage.

## React Compiler work

- Stance: Rejected for this Angular app.
- Reason: It does not target the current renderer stack.
- Reopen when: The renderer stack changes with an explicit migration decision.

## Multi-user and hosted features

- Stance: Rejected for current product scope, with one narrow exception reopened on 5 November 2026.
- Reason: Team mode, avatars and cloud environments do not serve the current single-user desktop scope.
- Exception: James asked for a second person (Cyntia) to use his Harness from her own phone. The phone app has an
  owner and members. A member sees only their own sessions, runs them on a worker computer kept for them, in a folder
  James chooses, on the Claude and Codex accounts he ticks, and cannot reach automations, loops, Plan Queue, reviews,
  browser approvals, folders or history, and cannot change pause. It is not team mode: no shared workspace, no roles beyond owner and
  member, nothing hosted. Settings > Mobile > People manages it.
- Reopen when: James explicitly expands product scope beyond that.

## openclaw goals engine

- Stance: Rejected.
- Reason: Harness’s loop engine is richer; event-triggered automations additionally need a public HTTPS endpoint.
- Reopen when: A concrete unmet need and approved deployment model justify a separate engine.
