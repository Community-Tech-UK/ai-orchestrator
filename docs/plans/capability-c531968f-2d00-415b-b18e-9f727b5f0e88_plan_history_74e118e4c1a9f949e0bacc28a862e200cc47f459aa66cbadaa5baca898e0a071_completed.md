## Snapshot of capability-c531968f-2d00-415b-b18e-9f727b5f0e88_history.md

# History: capability repair c531968f (dev-app on a remote computer)

Round 1, 16 Nov 2026, about 20:25 to 20:30 BST (Unix ms 1794860700000 to 1794861000000). Redacted.

- `dev-app.js status`: test Mac "no Harness copies here"; "the Windows PC could not be reached".
- `ssh -F remote-checks/ssh_config harness-checks 'echo ok'` (twice, minutes apart): TCP connection established, then "Connection timed out during banner exchange".
- `ssh ct-test-mac uptime`: load averages 166 / 138 / 136, then 180 / 150 / 141, on 10 processors. Top processes were many short `remote-checks/node` runs plus one long `node`: other jobs' test runs.
- Tailscale on this Mac: the PC (`9950x3d`) shown active, direct connection.
- Read-only `run_on_node` diagnostic on windows-pc (instance terminated afterwards): `harness-checks` WSL distro running, sshd active, listening on 2222, 0 pending startups, last log entry 17:12; Windows side `wslrelay` listens on 127.0.0.1:2222 with a CloseWait socket; `tailscaled` also listens on 2222 on the Tailscale addresses; no portproxy rules; PC CPU 8%; WSL VM about 22 GB. Nothing was changed.
- `AIO_DEVAPP_RECHECK_MS=20000 dev-app.js start --port 9341 --data /tmp/aio-lt-cap-c531968f --remote-only` for 90 s: "waiting for a remote computer that can run this copy (the test Mac is busy (load 152 to 158 on 10 processors); the Windows PC could not be reached)". Nothing was sent or started; no leftover process; status afterwards still empty on the test Mac.

Conclusion: no code defect. Both remote computers were unavailable for environmental reasons. No source file in the worktree was changed, so no tests or gates were affected; the project gates were not rerun.

Round 3, 18 Nov 2026, about 10:59 to 11:10 BST. Redacted.

- Before starting: `ssh -F remote-checks/ssh_config harness-checks 'echo ok'` printed ok (PC relay recovered); `dev-app.js status` empty on both computers; this Mac load about 11.
- `dev-app.js start --port 9347 --data /tmp/aio-lt-cap-c531 --remote-only` exit 0 in a few minutes. Receipt: `AIO_DEV_APP_RECEIPT {"tree":"6dd16941c7db2f964d2847616ac193032a545d55","startedAt":"2026-11-18T10:59:18.999Z","computer":"ct-test-mac","mode":"dev"}`.
- CDP `/json/version` on 127.0.0.1:9347: Harness(Dev)/0.1.0, Electron/42.11.18. One page, title Harness, route /setup.
- Session reload step: over CDP, read page state, `Page.reload` (ignoreCache), waited 6 s, read again: same URL and title, `electronAPI` object present, same visible text (setup screen). Renderer came back with no error.
- `dev-app.js stop --port 9347`: stopped; `status` shows no copy of mine (two other jobs' copies remain on the test Mac, untouched). Temp scripts removed.
- No source change; project gates not rerun this round.
