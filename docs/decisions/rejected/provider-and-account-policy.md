# Provider and account policy

Source: October 10 and October 20 research lists (`claude_oct-todo.md`, “Previously rejected” and “Considered and rejected”; `claude_oct-2-todo.md`, AppendixC). These are recorded stances, not new measurements. Reopening needs the condition below, not another unscoped sweep.

## Shared rate-limit pacing/admission gate

- Stance: Rejected for now.
- Reason: Only six provider-limit events in 30 days were observed and no herd was measured.
- Reopen when: Repeated measured herd behavior remains after account-specific holds work.

## Strip James’s plugins and servers from machine-started Codex

- Stance: Rejected.
- Reason: Decision 2 on 10 October declined this change.
- Reopen when: James explicitly changes that decision.

## Claude mcp_toggle as a session-only control

- Stance: Rejected.
- Reason: It persists per folder, so it cannot implement a this-session-only switch.
- Reopen when: A supported session-scoped API becomes available.

## Claude idle compaction inside Harness

- Stance: Rejected as currently available.
- Reason: It is terminal-only and server-gated.
- Reopen when: The installed CLI exposes a supported non-terminal contract and tests verify it.

## Codex thread/sample side questions

- Stance: Rejected for now.
- Reason: The installed CLI lacks the surface and Harness has no tool-less check-in need for it.
- Reopen when: A supported installed CLI contract and concrete tool-less check-in need exist.
