# Plan Queue programme: queue sessions on remote machines cannot push — implementation plan

**Status:** Draft, written 4 November 2026. Follow-up to step 1.9 of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md), raised by an automated security review of the 1.9 change. Queued as its own job. **Implemented 5 November 2026 in the queue worktree; awaiting independent verification. The real-node check is deferred to [2026-11-04-pq-b4-remote-push-guard_plan_livetest.md](2026-11-04-pq-b4-remote-push-guard_plan_livetest.md).**

## Goal

A Plan Queue session (worker, checker, triage, or any session one of them starts) that runs on a **remote node** must be blocked from pushing, as local queue sessions already are.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/decisions/rejected/`.
- The programme plan's step 1.9 and its as-built note; `src/main/plan-queue/plan-queue-push-guard.ts` (+ spec); `createRuntimeAdapter` in `src/main/instance/instance-lifecycle.ts`; `src/main/cli/adapters/remote-cli-adapter.ts`; `getHarnessCliEnv` in `src/main/instance/lifecycle/spawn-config-builder.ts` (it returns nothing for remote sessions); how the worker agent (`src/worker-agent/`) starts a provider CLI and what environment it gives it. Re-check every line number: the code has moved.

## The gap

`createRuntimeAdapter` builds the guard environment (the marker `AIO_QUEUE_SESSION`, numbered `GIT_CONFIG_*` entries with `pushInsteadOf` for the usual address forms, and a blocked `pushurl` for each remote that has its own) only when the session is **not** remote. For a remote session only the Claude deny rules (`QUEUE_DENIED_TOOLS`) are applied. A queue worker on a remote node can therefore still `git push`.

## What to build

1. Find out first, with evidence from the code, whether the remote adapter forwards `options.env` to the provider CLI on the node and whether the node's own environment filtering (for example Codex's shell policy) keeps the guard variables. Write the finding in the as-built notes before designing.
2. Make a remote queue session carry the same protection. The remote node holds the repository, so the per-remote `pushurl` entries cannot be read on this machine: either send the fixed part (marker plus the `pushInsteadOf` entries) and let the node add the `pushurl` entries for the remotes it has when it starts the session, or ask the node for its remote list. If neither is safely possible for a provider, **refuse to start that provider's queue sessions on a remote node** with a plain reason, rather than start them unguarded.
3. Keep the local behaviour exactly as it is.

## Rules for this job

- Do only this. Read every file you change whole, with callers and tests. New logic goes in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Tests run real git for each address form, and every new guard is mutation-checked (remove it, confirm a test fails). A real remote node cannot be started in a test: write the per-provider, on-a-real-node check as a `_livetest.md` beside this plan (header, steps, expected result, why it cannot run now) and do not claim it verified.
- Text a user can see follows `docs/screen-and-wording-guide.md`. Do not commit, push, create branches or worktrees, or install packages. Never put secrets in files.

## Acceptance criteria

- A queue session started on a remote node has the guard (or is refused with a plain reason); a test shows the environment/refusal reaches the remote spawn options.
- A normal (non-queue) remote session is unaffected.
- Local queue sessions behave exactly as before; the existing push-guard tests pass unchanged.
- A `_livetest.md` records the check on a real remote node, and the as-built notes say what was and was not verified.

## Verification

Run the targeted tests for what you changed, then:

- `npx tsc --noEmit`
- `npm run typecheck:spec`
- `npm run lint`
- `npm run check:ts-max-loc`
- `npm run check:ui-hints`
- `npm run build:main`
- `npm run build:renderer`
- `npm run test:quiet`

(Known: three `scripts/__tests__` tests fail on this machine because the installed Vite is older than `package.json` asks for; an environment fault, not yours. Say so rather than hide it.)

## Checklist

- [x] Evidence on how a remote session gets its environment written down
- [x] Remote queue sessions guarded or refused, with tests
- [x] `_livetest.md` written for the real-node check
- [x] As-built notes written below

## As-built notes

### Evidence: how a remote session gets its environment (written before the design)

- `RemoteCliAdapter.spawn()` builds the `instance.spawn` request field by field (`src/main/cli/adapters/remote-cli-adapter.ts`, the `sendRpc` call). `options.env` is **not** in it. So on a remote node the guard environment built by `createRuntimeAdapter` would never have arrived, even if it had been built; `getHarnessCliEnv` returning nothing for remote sessions is the same rule.
- The node builds its own environment: `LocalInstanceManager.spawn` (`src/worker-agent/local-instance-manager.ts`) starts with only `ANDROID_SERIAL`, `AIO_BROWSER_URL` and `AIO_AXE_RUNNER` and passes it as `env` to `createCliAdapter`, the same factory the coordinator uses locally.
- Every provider factory (Claude, Codex, Gemini, Antigravity, Copilot, Cursor, Grok, OpenCode) passes `options.env` through `mergeSpawnEnv` to the child process (`adapter-factory.ts`, `grok-adapter-factory.ts`, `opencode-adapter-factory.ts`). Claude merges it in `createClaudeAdapter`. So an environment given to `createCliAdapter` on the node gets the same treatment as locally.
- Codex's own shell filter: `CodexHomeManager` is given the adapter's `env` as `harnessCliEnv` (`codex-base-adapter.ts`), and `preserveHarnessCliShellPolicy` keeps the guard variables when `AIO_QUEUE_SESSION` is in it. That happens inside the node's own adapter, so it works the same on the node once the variables are in `env`.
- The Claude deny rules already reach the node: `disallowedTools` is in the spawn request. They were never the gap.
- The per-remote `pushurl` entries come from `git config` in the repository, which exists on the node, not on the coordinator.

### What was built

- The controller sends a flag, not an environment. `createRuntimeAdapter` (`instance-lifecycle.ts`) sets `queuePushGuard: true` for a queue session on a remote node (new `UnifiedSpawnOptions.queuePushGuard`); the local path is untouched (still builds `buildQueuePushGuardEnv` there).
- The flag travels in `RemoteSpawnMetadataSchema` (`remote-spawn-metadata.ts`), which `InstanceSpawnParamsSchema` spreads, so it reaches the node's `SpawnParams`. (It is there rather than in `rpc-schemas.ts` only because that file is already over its size ceiling.)
- The node builds the guard: `LocalInstanceManager.spawn` calls `buildQueuePushGuardEnv(params.workingDirectory, env)` against its own repository and merges the result into the `env` it gives the adapter. Hibernate and wake re-run it, because the stored spawn parameters carry the flag. An error from the build fails the spawn (nothing is swallowed there).
> Earlier journal sections moved to `2026-11-04-pq-b4-remote-push-guard_plan_history_36eb3e41de9d7cb1e9a88eb401b0104585953dfb9e38eb3edd82b10a10662a16_completed.md`.
