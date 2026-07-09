# Claude Code Instructions for AI Orchestrator

## Project Overview

This is an Electron + Angular desktop application that orchestrates multiple AI CLI instances (Claude, Gemini, Codex, Copilot). It provides multi-agent coordination, verification, debate systems, session recovery, resource governance, and memory management.

## Tech Stack

- **Frontend**: Angular 21 (zoneless) with signals-based state management
- **Backend**: Electron 40 (Node.js) with TypeScript 5.9
- **CLI Integration**: Multi-provider adapters (Claude, Gemini, Codex, Copilot)
- **Database**: better-sqlite3 for RLM/persistence
- **Validation**: Zod 4 for IPC payload schemas
- **Build**: Angular CLI + Electron Builder
- **Testing**: Vitest

## Development Commands

```bash
# Development
npm run dev                  # Start Electron app in dev mode
npm run build               # Build for production

# Quality Checks (ALWAYS run after changes)
npx tsc --noEmit            # TypeScript compilation check
npx tsc --noEmit -p tsconfig.spec.json  # Spec files must also compile
npm run lint                # ESLint check (uses ng lint)
npm run check:ts-max-loc    # TypeScript file size ratchet; fix any violations
npm run test                # Run tests (uses vitest)
```

## Running Tests (read before running the suite)

- **Prefer `npm run test:quiet`** over `vitest` / `npm test` directly. It prints
  only failures (each verbatim) plus a one-line pass summary, and tees the full
  output to `_scratch/test-run.log` for drill-down. Running the default reporter
  dumps ~10k tests' output into your context and forces a compaction.
- **During debugging, run the single relevant spec, not the whole suite:**
  `npm run test:quiet -- path/to/file.spec.ts`. Targeted runs also skip the
  slower full-gate preflight.
- **Reserve the full suite for a final gate** once the targeted spec is green —
  not mid-investigation.
- **Slow tier** (`*.e2e.spec.ts`, `**/soak.spec.ts`) is excluded from the default
  suite. Run with `npm run test:slow` (also a CI job). Load/bench stay on
  `test:load` / `bench`.
- **Cache** is on by default for warm re-runs. Force a cold cache after mass
  deletes/renames with `AIO_TEST_NO_CACHE=1` or `--no-cache`.
- **CI shards** with `npm run test -- --shard=N/4`. Locally you usually want the
  unsharded default suite.
- **Vitest projects**: `renderer` (jsdom + Angular TestBed) and `main` (jsdom +
  zone, no Angular). Both stay `singleFork` until an isolation audit unlocks
  parallel forks; CI sharding is the multi-core path today.
- On failure, `test:quiet` adds a TL;DR from a **local** model (Ollama / LM Studio)
  if one is reachable — zero cloud tokens. Point it at a LAN box with
  `AIO_AUX_LLM_URL=http://<host>:11434`, or it reads the endpoint configured in
  the app's Settings → Auxiliary Models. Disable with `AIO_TEST_SUMMARY=0`.

## Critical Rules

- **NEVER commit or push** unless the user explicitly asks you to
- **NEVER modify code on a server** — always make changes locally so we can deploy through the proper pipeline and code does not get out of sync
- **NEVER commit unfinished plans/specs**. Keep unfinished planning documents untracked. Only commit a planning document after it has been fully implemented and verified; rename it with `_completed` before committing, for example `feature-plan_completed.md`.
- **Secret hygiene role**: Never put secrets, credentials, tokens, OAuth client IDs, client secrets, refresh tokens, private keys, passwords, or anything that looks like one into repo files, docs, tests, plans, fixtures, screenshots, logs, or committed examples. Use environment variables, ignored local files, OS keychain storage, runtime discovery from an installed tool, or obvious non-secret placeholders instead.

## Implementation Requirements

### After Making Code Changes

**ALWAYS verify your changes compile and lint correctly:**

1. Run `npx tsc --noEmit` - Must pass with no errors
2. Run `npx tsc --noEmit -p tsconfig.spec.json` - Spec/test files must also compile
3. Run `npm run lint` or `npx eslint <modified-files>` - Fix any errors introduced
4. Run `npm run check:ts-max-loc` - Fix any TypeScript file size violations
5. If tests exist for modified code, run them

### Code Style

- Use `const` instead of `let` when variables aren't reassigned
- Use generic type arguments on constructors, not variable declarations:
  ```typescript
  // Good
  private cache = new Map<string, Entry>();

  // Bad
  private cache: Map<string, Entry> = new Map();
  ```
- Remove unused imports
- Don't use type annotations when types can be inferred from literals

## Architecture

For detailed architecture, domain map, and subsystem docs, read `docs/architecture.md`.

Key directories: `src/main/` (Electron/Node), `src/renderer/` (Angular), `src/shared/` (types), `src/preload/` (IPC bridge).

## Harness CLI Repair Surface

For the bundled `aio-mcp` CLI, read `docs/AIO_MCP_CLI.md`. Spawned local agents
that need to inspect or repair Harness settings should read
`docs/llm/AIO_MCP_CLI_REFERENCE.md` and use `$AIO_MCP settings ...` instead of
editing settings files directly. Never print the injected socket, instance id,
or secret/redacted setting values.

## Bigchange Implementation Process

When implementing features from `bigchange_*.md` files:

1. **Read the plan thoroughly** before starting
2. **Check existing code** - features may already be partially implemented
3. **Implement incrementally** - complete one phase at a time
4. **Verify each change**:
   - `npx tsc --noEmit` - TypeScript must pass
   - `npx tsc --noEmit -p tsconfig.spec.json` - Spec files must also compile
   - `npm run lint` - Fix any lint errors
   - `npm run check:ts-max-loc` - Fix any TypeScript file size violations
5. **Audit integration** - Ensure new code is actually used:
   - Imports are added where needed
   - Singletons are initialized in `src/main/index.ts`
   - Event listeners are connected
   - IPC handlers are registered

## Common Patterns

- **Singletons**: Lazy `getInstance()` + `getXxx()` convenience getter + `_resetForTesting()`. See any existing service for the pattern.
- **Logging**: `const logger = getLogger('MyService');` — use `logger.info/warn/error`.
- **DI (main process)**: Access singletons via `getXxx()` helpers. Use constructor injection for parent-passed deps.
- **DI (Angular)**: Use `inject()` function. Stores are injectable signal-based services.
- **IPC**: Handlers in `src/main/ipc/`, exposed via `src/preload/preload.ts`. Validate payloads with Zod schemas from `src/shared/validation/ipc-schemas.ts`.
- **Angular components**: Standalone, `OnPush` change detection, signals for state.
- **Testing singletons**: Call `MyService._resetForTesting()` in `beforeEach`.

## Scratch and archive directories

We use these directory names by convention for non-code content. Codemem skips them when walking into a workspace.

- `_scratch/` for short-lived dev cruft (PR review worktrees, investigation copies, experiments). Safe to delete without warning.
- `_archive/` for kept-but-stale content (old snapshots, retired modules). Kept for reference; not actively maintained.

Drop ad-hoc work into `_scratch/`. When we finish a feature and want to keep the investigation artefacts, we move them to `_archive/`. Don't put real source code in either; they're not indexed and search won't find them.

If we deliberately open `_scratch/foo` as a workspace, AI Orchestrator still indexes it. The skip rule only applies to these names appearing as children of an opened workspace.

The ignore list lives in `src/main/codemem/code-index-watcher.ts` (`DEFAULT_CODE_INDEX_IGNORES`).

## Packaging Gotchas

The packaged DMG has silently broken twice via these two traps. The `prebuild`
script now guards #2, but both still need attention when making the relevant
change.

### 1. Adding a `@contracts/schemas/...` or `@contracts/types/...` subpath

Files under `packages/contracts/src/schemas/` are named `<name>.schemas.ts`
(similarly `<name>.types.ts`), but imports use the short form
`@contracts/schemas/<name>`. That discrepancy is bridged by **three** places
that must stay in sync — tsc path aliases are type-check-only and do not
rewrite emitted JS:

1. `tsconfig.json` — renderer + test type-checking
2. `tsconfig.electron.json` — main-process type-checking
3. `src/main/register-aliases.ts` (`exactAliases`) — **Node runtime resolver**

Miss #3 and the packaged app crashes on startup with
`Cannot find module '…/schemas/<name>'` even though typecheck and lint pass.

Also update `vitest.config.ts` if the new subpath is imported from tests.

### 2. Bumping Electron

Native modules (`better-sqlite3`) must be recompiled against Electron's ABI
whenever the Electron version changes. The `postinstall` hook handles fresh
installs, but a standalone `npm install electron@<new>` won't re-trigger it.

After bumping Electron:

```bash
npm run rebuild:native
```

`scripts/verify-native-abi.js` runs in `prebuild`/`prestart` and fails fast if
the bundled `.node` binary's `NODE_MODULE_VERSION` doesn't match the installed
Electron — catching the stale binary before it's packaged into a DMG.

### 3. Adding a native (compiled) dependency

`electron-builder.json` sets `"npmRebuild": false` — electron-builder does **not**
recompile native modules at package time. (It still installs and bundles them;
`npmRebuild` only controls the source recompile.) This is deliberate: native ABI
is managed out-of-band, and `npmRebuild: true` would force a node-gyp source
compile of every native dep — which needs an MSVC/C++ toolchain and breaks on
hosts without one (e.g. `node-pty` failing with "Could not find any Visual Studio
installation").

This works because every current native dep is already covered without a compiler:

- **N-API modules** (`node-pty`, `lmdb`, `msgpackr-extract`) ship ABI-stable
  prebuilt binaries that load in both Node and Electron as-is. No rebuild needed.
- **Non-N-API modules** (`better-sqlite3`) get an Electron-ABI binary from
  `rebuild:native` (prebuild-install `--runtime electron`), guarded by
  `verify-native-abi.js`.

When adding a **new non-N-API native module**, do one of:

1. Add it to `NATIVE_MODULES` in both `scripts/rebuild-native-modules.js` and
   `scripts/verify-native-abi.js` (preferred — keeps the no-compiler strategy), or
2. Re-enable `"npmRebuild": true` (reintroduces the MSVC toolchain requirement on
   the build host).

Check whether a module is N-API by looking for a `node-addon-api`/`node-gyp-build`
dependency and a `prebuilds/` dir (or `@scope/<mod>-<platform>` prebuilt package).
The `verify-native-abi.js` guard only checks `better-sqlite3`, so a new non-N-API
module added without step 1 would ship a wrong-ABI binary **silently**.
