# AI Orchestrator Agent Instructions

AI Orchestrator is an Electron 40 + Angular 21 desktop app that coordinates Claude, Gemini, Codex, and Copilot CLIs. The main process is TypeScript/Node, the renderer is zoneless Angular with signals, persistence uses better-sqlite3, IPC payloads use Zod 4, and tests use Vitest.

## Critical Rules

- Read the entire file and its relevant callers, types, and tests before editing it. Trace the real call path; do not guess.
- Reproduce bugs before fixing them. Verify the real behavior before changing tests.
- Never commit or push unless the user explicitly asks.
- Never modify code on a server. Make changes locally and use the normal deployment pipeline.
- Never put secrets, credentials, tokens, OAuth values, private keys, passwords, or realistic secret-like values in repo files, tests, fixtures, screenshots, logs, or examples. Use environment variables, ignored local files, OS keychain storage, runtime discovery, or obvious placeholders.
- Do not commit unfinished plans or specs, including specs marked `_planned`. After full implementation and verification, rename them with `_completed` before committing. Checks that genuinely need a rebuilt or restarted app, a human, or an external service may be deferred into a `_livetest.md` doc first — see Live-Test Deferral below.
- Preserve unrelated work in a dirty tree. Do not discard, reset, or overwrite user changes.

## Plan and Spec Filename States

- `*_spec.md` means the spec does not yet have an implementation plan.
- When a plan is created from a spec, link the spec to the plan, rename the spec to `*_spec_planned.md`, and verify that both files remain untracked. `_planned` records only that the plan exists; it is not a completion or commit-ready state.
- `*_plan.md` means implementation work is active. Keep it and its linked `*_spec_planned.md` file uncommitted while work continues.
- After every required item is implemented and verified, update both documents' status/as-built notes, update the spec's link to the plan's completed filename, rename the plan to `*_plan_completed.md`, and rename the spec from `*_spec_planned.md` to `*_spec_completed.md`.
- Only `_completed` documents may be staged and committed with the completed work, subject to the Live-Test Deferral rules below.

## Before Writing Code

1. Read the relevant implementation, callers, types, adjacent tests, and architecture notes.
2. State what will change, why, what could break, and which checks cover it.
3. For a bug, reproduce it and form a root-cause hypothesis.
4. Implement the smallest complete change and confirm it is wired into the runtime, not merely present on disk.

For architecture and subsystem ownership, read `docs/architecture.md`. Key directories are `src/main/` (Electron), `src/renderer/` (Angular), `src/shared/` (shared types), and `src/preload/` (IPC bridge).

## Canonical Verification Checklist

After code changes, run all applicable targeted tests, then these project gates:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

- During investigation, prefer `npm run test:quiet -- path/to/file.spec.ts`.
- Reserve the full suite for the final gate. Slow tests use `npm run test:slow`.
- After multi-file changes, the full suite and lint are required; verify imports and exports resolve.
- Never claim completion without current command output or an appropriate real UI/runtime check.
- Report every requested item and its actual status. If incomplete, state what remains.

The quiet test runner, cache, sharding, and slow-tier details live in `docs/testing.md`.

## Development Commands

```bash
npm run dev
npm run build
```

## Documentation Formats

Split docs by audience: **Markdown for machines, HTML for humans.**

- Markdown is canonical for anything an agent reads or that lives in the repo long-term (conventions, runbooks, agent instructions, specs, plans). It is the source of truth. HTML is a disposable render target only.
- Any doc that requires James's review or approval (plans, decision docs, audits, reports) should be presented as a self-contained interactive **review artifact** per the artifact contract, generated into `.aio-review/` (never committed). The `doc-review-artifact` skill produces these.
- Never commit rendered HTML, and never treat an HTML artifact as the source of truth. Apply agreed changes to the Markdown source, then re-render.
- Plain-language decision docs keep the numbered-items convention (it matches how James answers — by number).
- `_completed` conventions and the loop evidence ladder are unchanged by this policy.

## Live-Test Deferral (`_livetest.md`)

A plan may be renamed `_completed` while some checks still await live validation, provided every remaining item genuinely requires a rebuilt or restarted app, human interaction, or an external service. All code, tests, lint, and other agent-runnable gates must already pass. Anything verifiable with unit or integration tests, the dev app (including renderer store seeding), or the CLI must be verified in-loop, never deferred.

Before renaming the plan:

1. Create `<plan-stem>_livetest.md` beside the plan. For each deferred check record the exact steps (commands or UI actions), the expected observable result, required flags or settings, and why it cannot run now. Add a header noting prerequisites (rebuild, restart, which instance) and a link back to the plan.
2. Move the deferred sections out of the plan, leaving a one-line pointer to the livetest doc. Never add content to the plan after it is `_completed`.
3. Rename the plan `_completed` last — the rename is the loop-completion trigger.
4. In the completion summary, describe the items as deferred live checks recorded in the livetest doc. Do not claim they are verified.

The livetest doc is itself a plan: run it against the rebuilt app (typically by dragging `*_livetest.md` files into a loop) and rename it `_livetest_completed.md` only when every check passes with evidence. Searching for `*_livetest.md` lists all pending live testing.

## TypeScript and Angular Conventions

- Prefer `const` when a binding is not reassigned.
- Put generic arguments on constructors: `new Map<string, Entry>()`.
- Omit type annotations that TypeScript can infer from literals.
- Remove unused imports.
- Angular components are standalone and `OnPush`; use `inject()` and signals.

The complete repo-local Angular conventions are in `docs/angular-conventions.md`. Prompt changes must follow `docs/prompt-engineering-house-style.md`.

## Architecture Patterns

- Main-process singletons: lazy `getInstance()`, a `getXxx()` helper, and `_resetForTesting()`.
- Logging: `const logger = getLogger('MyService');` and `logger.info/warn/error`.
- Main-process dependencies: singleton helpers or constructor injection from the parent.
- Angular dependencies: `inject()`; shared state uses injectable signal stores.
- IPC: handlers in `src/main/ipc/`, preload exposure in `src/preload/preload.ts`, and Zod schemas in `src/shared/validation/ipc-schemas.ts`.
- Singleton tests call `_resetForTesting()` in `beforeEach`.

When adding an `@contracts/schemas/...` or `@contracts/types/...` subpath, update `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, and `vitest.config.ts` when tests import it. TypeScript aliases do not rewrite emitted Node imports.

## Integration Checks

For big-change documents:

1. Read the whole plan and check for existing partial implementation.
2. Implement incrementally and run targeted checks after each phase.
3. Confirm imports, exports, singleton initialization in `src/main/index.ts`, event listeners, preload exposure, and IPC registration.
4. Run the canonical verification checklist before marking the document complete.

For the bundled `aio-mcp` CLI, read `docs/AIO_MCP_CLI.md`. Local agents repairing Harness settings must read `docs/llm/AIO_MCP_CLI_REFERENCE.md` and use `$AIO_MCP settings ...`; never print the injected socket, instance ID, or secret/redacted values.

Native dependency and Electron packaging procedures are in `docs/packaging-native-modules.md`. Follow that runbook whenever Electron or a compiled dependency changes.

## Scratch and Archive Directories

- `_scratch/` is disposable investigation output.
- `_archive/` keeps stale reference material.
- Do not place active source code in either directory; Codemem skips them as children of a workspace.
- The ignore list is `DEFAULT_CODE_INDEX_IGNORES` in `src/main/codemem/code-index-watcher.ts`.
