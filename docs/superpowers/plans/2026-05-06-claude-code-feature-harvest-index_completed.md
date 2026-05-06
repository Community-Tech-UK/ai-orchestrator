# Claude Code Feature Harvest Plan Suite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sequence the approved Claude Code feature-harvest spec into independently executable implementation plans.

**Architecture:** The harvest is split into seven deployable slices. MCP work is intentionally sequenced through the existing April MCP management plan first, then the harvest-specific MCP follow-ups.

**Tech Stack:** Electron 40 main process, Angular 21 standalone/signal stores, TypeScript 5.9, Zod 4 contracts, better-sqlite3, Vitest, existing IPC generation.

---

## Source Spec

- `docs/superpowers/specs/2026-05-06-claude-code-feature-harvest-design.md`
- MCP prerequisite: `docs/superpowers/plans/2026-04-21-mcp-multi-provider-management_completed.md`

## Execution Order

1. `docs/superpowers/plans/2026-05-06-thread-wakeups-and-loops_completed.md`
2. `docs/superpowers/plans/2026-05-06-automation-preflight-and-templates_completed.md`
3. `docs/superpowers/plans/2026-04-21-mcp-multi-provider-management_completed.md`
4. `docs/superpowers/plans/2026-05-06-mcp-feature-harvest-followups_completed.md`
5. `docs/superpowers/plans/2026-05-06-runtime-plugin-package-manager_completed.md`
6. `docs/superpowers/plans/2026-05-06-headless-review-command_completed.md`
7. `docs/superpowers/plans/2026-05-06-prompt-history-all-project-recall_completed.md`
8. `docs/superpowers/plans/2026-05-06-provider-diagnostics_completed.md`

## Global Rules

- Use a fresh branch/worktree before implementation work.
- Do not start MCP harvest follow-ups until the April MCP management baseline has shipped or been explicitly superseded.
- Keep implementation slices independent. Do not fold plugin, review, prompt history, and diagnostics changes into the automation branch.
- After each slice, run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

- Also run focused Vitest commands listed in the slice plan.

## Status Checklist

- [x] Thread wakeups and loops plan executed.
- [x] Automation preflight/templates plan executed.
- [x] April MCP management baseline executed or explicitly superseded.
- [x] MCP HTTP/tool-search follow-up plan executed.
- [x] Runtime plugin package-manager plan executed.
- [x] Headless review command plan executed.
- [x] Prompt-history all-project recall plan executed.
- [x] Provider diagnostics plan executed.
