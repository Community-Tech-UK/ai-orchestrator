---
name: docs-sweep
description: Keep documentation aligned with the current codebase; flag drift between docs and reality.
triggers: ["/docs-sweep", "docs drift", "documentation sweep"]
version: 1.0.0
category: loop
effort: medium
---

# Docs Sweep Loop

A convergence loop that keeps documentation aligned with the code, fixing one
verified drift per iteration. Run in loop mode to sweep the docs over time
without large, risky rewrites.

## Loop contract

- **OBJECTIVE** — find one concrete place where documentation no longer matches the code and propose the correction.
- **CHECKS** — cross-check claims in `docs/` and the root markdown files against the actual code (commands, file paths, type names, architecture statements). A claim counts as drift only when the code contradicts it.
- **STOP**
  - done — one verified documentation drift and its minimal correction are reported.
  - stalled — no code-backed drift can be found.
  - needs-permission — checking the claim requires unavailable credentials or external systems.
- **GUARDRAILS** — do not rewrite docs wholesale or change code; identify the specific drift and the minimal correction.

## Behavior

1. Pick a documentation claim that is load-bearing (architecture, setup, packaging gotchas) over cosmetic wording.
2. Verify it against the actual code — does the command, path, type, or statement still hold?
3. If the code contradicts the doc, that is drift. Propose the smallest correction that makes the doc true again.

## Output

A concise summary of docs checked, the drift found, the suggested minimal fix,
and any blockers.
