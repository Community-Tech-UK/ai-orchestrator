## Snapshot of capability-7eb07634-ef65-414b-9ad6-fe6a8e38a831_history.md

# History: capability repair 7eb07634 (windows-dev-app-cdp-tunnel)

## Round 1 (worker, 26 Nov 2026)

Reproduction (windows-pc, port 9461, own data folder /tmp/aio-lt-cap7eb, worktree at the checked tree):
- `dev-app.js start --windows` run alone succeeded: copy ready, tunnel up, `/json/version` answered through it (8 of 8 requests, 20-60 ms), `seed` filled the screens once the window had loaded (a seed run straight after start said "still waiting for: AI tool list"; that wait is existing seed behaviour and unrelated to the tunnel).
- `~/.ai-orchestrator/remote-checks/runs.jsonl` showed six dev-app starts between 23:03 and 23:11 ended "the port was in use here" (2) or "the tunnel did not open" (4+). `9455.tunnel.log` held only `held`, with an mtime equal to the moment that run ended. Inference (not observed directly): the tunnel's SSH session took longer than the 20 s wait; the launcher gave up, stopped the freshly built copy, and the late SSH process was left; leftovers explain the "port in use" starts.
- PC SSH round trip was 0.2 s when measured later, so the slowness was transient (several agents were starting copies at once).

Change: see plan "Refined implementation". Files: scripts/remote-checks/dev-app.js, remote-run.sh, dev-app.spec.ts.

Checks:
- `npm run test:quiet -- scripts/remote-checks/dev-app.spec.ts`: 112 passed (run on the Windows PC).
- `npm run checks` (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer): all passed.
- Real forced-failure run on the PC (`AIO_DEVAPP_TUNNEL_WAIT_MS=1 start --windows`): 3 attempts, copy stopped, message "the copy does answer on the Windows PC itself, so it is the connection from this Mac that fails", reasons kept in 9461.tunnel.log, port 9461 free, no copy left.
- Real normal run with the changed launcher: ready, navigator.platform Win32, CDP answered at http://127.0.0.1:9461; stopped cleanly (port free, status shows no copy on 9461).

Not done by the worker: the independent runtime probe on the reviewed checkpoint (plan acceptance item 5).
