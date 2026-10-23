# Ui and product scope

Source: October 10 and October 20 research lists (`claude_oct-todo.md`, “Previously rejected” and “Considered and rejected”; `claude_oct-2-todo.md`, AppendixC). These are recorded stances, not new measurements. Reopening needs the condition below, not another unscoped sweep.

## LLM follow-up suggestions, composer predictions and autocomplete

- Stance: Rejected.
- Reason: They add a hidden model call over context for every reply; Codex removed follow-up suggestions within three days.
- Reopen when: An opt-in trial demonstrates a concrete benefit at an accepted measured cost.

## Idle nudges and first-run welcome wizards

- Stance: Rejected.
- Reason: Repeated upstream attempts were removed; no current measured need justifies the interruption.
- Reopen when: Observed usability failures and user research justify a targeted flow.

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

- Stance: Rejected for current product scope.
- Reason: Team mode, avatars and cloud environments do not serve the current single-user desktop scope.
- Reopen when: James explicitly expands product scope.

## openclaw goals engine

- Stance: Rejected.
- Reason: Harness’s loop engine is richer; event-triggered automations additionally need a public HTTPS endpoint.
- Reopen when: A concrete unmet need and approved deployment model justify a separate engine.
