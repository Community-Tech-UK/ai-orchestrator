# Privacy and architecture

Source: October 10 and October 20 research lists (`claude_oct-todo.md`, “Previously rejected” and “Considered and rejected”; `claude_oct-2-todo.md`, AppendixC). These are recorded stances, not new measurements. Reopening needs the condition below, not another unscoped sweep.

## Browser automation of logged-in AI tabs

- Stance: Rejected as a provider integration.
- Reason: The existing CLI provider boundary is supported; driving logged-in AI tabs is outside the accepted integration design.
- Reopen when: James explicitly requests and authorizes a particular new provider integration.

## Remote telemetry

- Stance: Rejected.
- Reason: Research tool-usage telemetry is outside James’s local privacy boundary.
- Reopen when: James explicitly opts into a concrete scoped telemetry design.

## Second policy engine or shadow task ledger

- Stance: Rejected.
- Reason: Parallel authorities drift; use the existing policy and durable task ownership.
- Reopen when: The existing authority demonstrably cannot represent a required invariant and a migration is approved.
