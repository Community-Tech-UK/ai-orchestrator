## Snapshot of capability-cd33bb0f-a777-4078-9e83-728e0fd3ee60_history.md

# History: capability repair cd33bb0f (account_trial)

## Round 1 (27 Nov 2026, queue worker)

Reproduction: `get_setting providerAccountProfiles` returned `writable:false, policyTier:"read-only"`; ClaudeSUAS is the
Claude `legacy` profile (`disabled`), CodexSUAS the Codex `legacy` profile (`allow-routed`); no MiMo "subs" profile.
No orchestrator tool starts a session on a named account. Routing code: `provider-account-routing-service.ts:363`
refuses an explicit `disabled` profile, accepts `manual-only` for an interactive origin; OpenCode ignores the account
unless the model is a logical MiMo model (`account-route-preflight.ts`).

Built: `src/shared/types/account-trial.types.ts`, `src/main/providers/account-pool/account-trial-lease-service.ts`,
`src/main/mcp/orchestrator-account-trial-tools.ts`, `src/main/app/account-trial-wiring.ts`; wired through
`orchestrator-tools.ts`, `orchestrator-tools-rpc-server.ts` (toolset: in full, not leaf), the forwarder and
`orchestrator-tools-step.ts`; `displayName` passthrough in `instance-create-with-message.ts`; schema byte ceiling raised
to 90,624 (tool adds about 2 KB). Runbook row added at `docs/plans/livetest-capability-repair-runbook.md` (root,
untracked there).

Fresh-context review (sonnet, read-only) found: (1) a refused account route is a background failure, so start_session
reported success: fixed by waiting for `readyPromise`, terminating and throwing; (2) unreadable lease file could abort the
whole tools step: now caught and the tool reports unavailable; (3) lease-file entries were under-validated, including the
policy written back: now validated, otherwise the file is set aside; (4) sessions have no parent so the spawn-depth limit
does not count them: recorded as a known gap; nits: no new sessions on a lease being released, a failed lease-file rewrite
no longer stops sessions being stopped, hand-set `manual-only` cannot be told from the lease's own write (documented).

Checks (all via the test machine): `npm run checks` (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints,
build:main, build:renderer) exit 0; `npm run build:aio-mcp-dist` exit 0; `npm run test:quiet -- src/main/app src/main/mcp
src/main/providers/account-pool src/main/ipc/handlers`: 252 files, 4,346 tests passed; the new specs: lease service 35,
tool 5, wiring 6. Generators run: no generated file changed.

Not done here: the runtime probe (needs an app copy built from this change on the PC or test Mac); the originating
check's MiMo arm (account not in Harness).

## Round 2 (27 Nov 2026, queue worker)

Verifier finding: in an ordinary session, approving the held `account_trial` card then failed with "unknown orchestrator-tools
instance" (no lease log line; policies unchanged); an owned yolo session worked. Root cause: held `mcp__orchestrator__*`
tools take the deferred path (`deferred-permission-handler.ts`), which sets the instance `respawning` and restarts the CLI;
the restarted CLI replays the approved call at once, and `isKnownLocalInstance` (`orchestrator-tools-step.ts`) refuses
`respawning` (`RPC_INACTIVE_STATUSES`, deliberately, and spec-covered). This hit every held orchestrator tool, not only
`account_trial`.

Fix: `src/main/instance/lifecycle/deferred-permission-resume-registry.ts` (mark/clear/is); the handler marks the instance
before both `respawning` transitions (resident and normal path) and clears it in its `finally`; `isKnownLocalInstance`
accepts `respawning` only while marked. Other refused statuses, termination and abort checks are unchanged. Specs: new
`deferred-permission-handler.resume-mark.spec.ts` (mark visible during spawn, cleared on success and on failure) and a case
in `orchestrator-tools-step.spec.ts` (accepted only while marked). Livetest check 0 added for the ordinary-session path.

Checks (test machine): `npm run checks` exit 0 (all 7); `npm run test:quiet -- src/main/instance src/main/app src/main/mcp`
453 files, 7,188 tests passed. Not done here: the live probe.

## Verifier round 2

Finding: concurrent `start_session` calls each checked `lease.sessionIds.length` before awaiting the start, so 17+ at once
could exceed the 16-session cap. Fix (`account-trial-lease-service.ts`): a per-lease `starting` counter is incremented before
the first await and decremented in `finally`; the cap check uses `sessionIds.length + inFlight`. Two specs added (20
simultaneous starts yield exactly 16; failed starts return their slot).

Checks: `test:quiet` on the lease spec 37 passed; `npm run checks` typecheck, typecheck:spec, lint, check:ts-max-loc exit 0.
