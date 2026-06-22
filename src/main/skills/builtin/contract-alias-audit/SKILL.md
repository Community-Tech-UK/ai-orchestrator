---
name: contract-alias-audit
description: Verify @contracts subpaths stay in sync across the three alias sites the packaged DMG depends on.
triggers: ["/contract-alias-audit", "contract alias sync", "register-aliases drift"]
version: 1.0.0
category: loop
effort: medium
---

# Contract Alias Sync Audit Loop

A guard loop for a packaging trap that has silently broken the DMG twice: tsc
path aliases are type-check-only and do **not** rewrite emitted JS, so a
`@contracts/...` subpath can typecheck and lint cleanly yet crash the packaged
app at runtime with `Cannot find module`.

## Loop contract

- **OBJECTIVE** — confirm every `@contracts/schemas/*` and `@contracts/types/*` subpath resolves at runtime, not just at typecheck.
- **CHECKS** — for each subpath alias, verify it is declared in *all* of:
  1. `tsconfig.json` (renderer + test type-checking)
  2. `tsconfig.electron.json` (main-process type-checking)
  3. the `exactAliases` map in `src/main/register-aliases.ts` (Node runtime resolver)
  4. `vitest.config.ts` — only if the subpath is imported from tests
  Report any subpath missing from one or more sites.
- **STOP**
  - done — all contract subpaths are checked and any drift is reported.
  - stalled — aliases cannot be enumerated from the repo.
  - needs-permission — verifying a path requires unavailable packaging credentials or external access.
- **GUARDRAILS** — do not edit alias files automatically; only report drift and the exact missing entries.

## Behavior

1. Enumerate every `@contracts/schemas/*` and `@contracts/types/*` import used across the codebase.
2. For each, check presence in the three (or four) sites above.
3. Flag any site where the subpath is absent — that is the runtime-crash risk.

## Output

A concise summary of subpaths checked, any out-of-sync sites, the exact entries
needed to fix each, and any blockers.
