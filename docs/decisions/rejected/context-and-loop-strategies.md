# Context and loop strategies

Source: October 10 and October 20 research lists (`claude_oct-todo.md`, “Previously rejected” and “Considered and rejected”; `claude_oct-2-todo.md`, AppendixC). These are recorded stances, not new measurements. Reopening needs the condition below, not another unscoped sweep.

## Fresh session every loop round

- Stance: Rejected as the default.
- Reason: Repeated cold starts re-read instructions and planning context; continuity is the existing design.
- Reopen when: A controlled trial shows equal completion quality at lower total usage, or James explicitly requests fresh rounds.

## Per-turn micro-compaction and CLI context tricks

- Stance: Rejected in Harness.
- Reason: The CLIs already own tool-result budgets, unchanged-file stubs and micro-compaction; Harness cannot rewrite their tool results.
- Reopen when: A supported provider API gives Harness ownership and a measured quality/savings trial succeeds.

## Default $30 loop cap

- Stance: Rejected.
- Reason: James explicitly removed this default on 2 September; notional list prices do not equal his subscription cost.
- Reopen when: James explicitly requests a new default cap.

## Hide fixed context overhead

- Stance: Rejected.
- Reason: Subtracting the baseline would hide the instruction and tool tax the context display deliberately exposes.
- Reopen when: James changes the display goal and an equally visible overhead breakdown exists.

## Separate pre-compaction memory-save turns

- Stance: Rejected.
- Reason: They add another model call; useful memory belongs in the existing summary prompt.
- Reopen when: Evidence establishes that summary-prompt inclusion loses required information.

## Loop definition-of-done card

- Stance: Rejected for this programme.
- Reason: The observed loop leak is the stop rule, rather than a missing goal card.
- Reopen when: Stop-rule fixes pass and separate observed failures are attributable to unclear completion criteria.

## Codex goal budgets, thread/queue, historyMode and experimental token budgets

- Stance: Rejected as token-saving levers.
- Reason: The October CLI investigation did not establish usable savings from these surfaces.
- Reopen when: Installed supported CLI behavior and an observed comparison establish a benefit.

## Hourly wake budgets and automation finding suppression

- Stance: Rejected for now.
- Reason: No event storms were measured: cadence quota holds were 1/94 failures and identical findings 3/399 runs.
- Reopen when: New measurements show recurring storms, quota holds or repeated findings as a material cost.

## Delegation completion delivered only as notes

- Stance: Rejected.
- Reason: It can stall overnight orchestrators that need a turn to continue; batch completion deliveries instead.
- Reopen when: An explicit scheduler wakes the orchestrator when work requires it, with unattended tests.
