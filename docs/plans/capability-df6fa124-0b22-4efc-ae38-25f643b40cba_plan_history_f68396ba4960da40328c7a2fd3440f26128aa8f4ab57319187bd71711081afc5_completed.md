## Snapshot of capability-df6fa124-0b22-4efc-ae38-25f643b40cba_history.md

# History: capability repair df6fa124 (round 1)

- Reproduced: no log of the overlay or the limits exists (`claude-cli-argv-builder.ts` `buildArgs complete` line, `claude-env-pack.ts` have none). `ps` and arg folders unreadable per the evidence.
- Finding: depth/spawn/concurrency/fork limits are env vars, not overlay keys. Two log lines added instead of one.
- Checks: `npm run test:quiet` on claude-cli-argv-builder.spec, claude-env-pack.spec, cli-spawn-worker-import-isolation.spec: 119 passed. Adapter + spawn-worker folders: 261 passed. `npm run checks` (typecheck, typecheck:spec, lint, ts-max-loc, ui-hints, build:main, build:renderer): all passed.
- Not done: runtime probe (needs rebuilt app; checker's job).

## Round 2 (verification round 1 finding)

Finding: live queue worker overlay logged `hookEvents {PreCompact:1}` with no PermissionRequest; the livetest expected both. Cause: `permissionHookEnabled` is false when `yoloMode` (claude-cli-argv-builder.ts), and queue workers run YOLO. Existing designed behaviour, not a logging defect, so the log line is accurate. Fix: corrected the livetest expectation (PermissionRequest/PreToolUse only for ask-first machine sessions) and added a spec for a YOLO plan-queue worker (precomputeCompactionEnabled present, no PermissionRequest/PreToolUse). The PreCompact hook command only resolves with the hook script on disk, so the unit test does not assert it.
Checks: test:quiet claude-cli-argv-builder.spec + claude-env-pack.spec: 118 passed (exit 0); npm run lint and typecheck:spec: pass.
