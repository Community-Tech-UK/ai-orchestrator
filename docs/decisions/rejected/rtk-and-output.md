# Rtk and output

Source: October 10 and October 20 research lists (`claude_oct-todo.md`, “Previously rejected” and “Considered and rejected”; `claude_oct-2-todo.md`, AppendixC). These are recorded stances, not new measurements. Reopening needs the condition below, not another unscoped sweep.

## Copy RTK filters into Harness

- Stance: Rejected.
- Reason: RTK owns the filters; duplicating them adds a second implementation to maintain.
- Reopen when: Upstream cannot support a required output type and a measured local filter is justified.

## Wrap the entire verification run in rtk err

- Stance: Rejected.
- Reason: That filter discards file and failing-test names needed as evidence.
- Reopen when: A verified filter preserves every failure identifier, command and actual exit status.

## Install global RTK hooks automatically

- Stance: Rejected.
- Reason: That edits James’s own agent configurations outside Harness-started sessions.
- Reopen when: James explicitly requests a named global configuration change.

## RTK proxy daemon, pipelines and cheaper-model read delegation

- Stance: Rejected.
- Reason: Candidates are lossy or BUSL-licensed and worth about 0.04% of cache reads in the October sample.
- Reopen when: A compatible licence and a quality-preserving benchmark show material gains.

## Elide repeated identical outputs

- Stance: Rejected on the prior evidence.
- Reason: The apparent duplicates were transcript double-logging, not repeated useful work.
- Reopen when: A deduplicated transcript demonstrates real avoidable repeated output.

## oh-my-codex sparkshell

- Stance: Rejected.
- Reason: Cheap-model output summaries lose detail and add a model call.
- Reopen when: A representative trial proves lossless required evidence and lower total usage.

## Ran N commands rollups

- Stance: Rejected as a replacement for individual commands.
- Reason: Upstream reverted them because failures disappeared inside the rollup; commands stay visible inside a summary.
- Reopen when: A design preserves each command result and failure while demonstrating useful reduction.
