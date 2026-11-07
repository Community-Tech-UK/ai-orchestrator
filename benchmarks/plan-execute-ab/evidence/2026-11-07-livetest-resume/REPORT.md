# Local pilot resume, 7 November 2026: evidence

Scope: the eligible local checks of the A/B pilot livetest (A1, A2, A4), run from the Plan Queue
worktree `queue/2026-10-14-local-model-plan-ex-a7a00e`. Nothing was committed. No cloud model was
called and no spend was incurred. No scored cell, judge or speed-gate verdict was produced.

## Results by check

| Check | Outcome | Basis |
| --- | --- | --- |
| Post-merge `npx tsc --noEmit` | PASS (exit 0) | Root `tsconfig.json` now excludes `benchmarks/plan-execute-ab/evidence`. The sealed `missing-node-tool.mts` file is untouched. `npm run typecheck:spec` also exits 0. |
| A1 model files | Re-inventoried, consistent with 2 Nov; not hashed, not loaded | Sizes read on windows-pc: 27B Q6 25,299,061,664 B; Flash-Next shards 10,946,624 and 49,835,229,856 B match. The third shard was cut off in transport and not re-read. |
| A2 serving and security | PASS for this window, with two recorded deviations | Native 2.60.0 loaded Qwen3.6-35B-A3B Q4_K_M, `n_slots=1`, `n_ctx_slot=65536`. Responses without a key, with a wrong key, and with the configured key were 401, 401, 200. Listener only on the Tailscale IPv6 address (owned PID 57332). Deviations below. |
| A3 speed gate and PCIe | NOT RUN | The gate needs a captured repository prompt of at least 30,000 tokens. The smoke prompt was 17,216 tokens, and no captured repository prompt exists in this worktree. PCIe was not sampled during inference. |
| A4 tool smoke and second-request timing | PARTIAL: 35B only | Tools ran, the answer is 42, and `npm test` passes with zero tool errors. The second request shows 39 new prompt tokens in 106 ms against 1,808 ms for the first (about 17,579 tokens reused). Deviations below. B, C1 and C2 repeats were not run. |
| A5, A6, A7 scored matrices | NOT RUN | Need accepted clean parent/fixed controls for all ten tasks, which do not exist. The workRoot isolation proof is also still open. |
| A8 report | NOT RUN | Depends on A5 to A7. |
| B1 to B4 | NOT ELIGIBLE | Need James: repository approval, prompt review, spend approval for the full run, and BIOS work. |
| C1 finishing (cleanup) | Mostly done; residuals listed | See the cleanup table. |

## Deviations from the runbook (recorded, not hidden)

1. **Bind address.** The server listens on `fd7a:115c:a1e0::434:5d68`, not the runbook's
   `100.113.93.104`. The Mac has no IPv4 route to the Tailscale address, so the runbook's own
   IPv6 workaround was used. The listener is verified as Tailscale-only (no LAN or wildcard).
2. **Translator upstream.** `local-anthropic-proxy.ts` cannot reach an IPv6 upstream: it passes
   `URL.hostname` with brackets to `http.request`, so the upstream fails with
   `getaddrinfo ENOTFOUND [fd7a:...]` (see `translator-8900.log`). I did not patch the frozen
   translator. A plain byte forwarder (`tcp-forward.mjs`) on `127.0.0.1:1236` carried the traffic
   to the server instead. The forwarder changes no payload. The defect is filed as an LT register item.
3. **Served model identifier.** The native server reports the full Windows model path, not the
   config's `qwen/qwen3.6-35b-a3b`. The ignored config was set to the discovered path, per the
   runbook's "use the exact discovered identifier" rule.
4. **Tool name.** The smoke agent used Write, not Edit, to change `answer.txt`. The runbook expects
   Edit. The result is correct, but the step is not strictly as written.
5. **Config scope.** The ignored config contains only the 35B arm. The smoke test reads only
   `localArms`. The workRoot isolation blocker covers scoring runs, not this smoke.
6. **Helper process.** The helper was unloaded with `lms unload` and reloaded with `lms load`
   (context 229,376, parallel 2, identifier unchanged, TTL none). Its PID changed from 42764 to
   54592. The GPU offload level cannot be read back from `lms ps`, so `--gpu max` is recorded as
   requested, not confirmed.

## Cleanup

| Item | Result |
| --- | --- |
| Native server PID 57332 | Stopped after its command line was checked. Port 1235 has no listener (six `TimeWait` entries clear by themselves). |
| Helper routing `auxiliaryLlmRoutingMode` | Paused to `off`, restored to `local-first`, read back. |
| Helper model | Unloaded, then reloaded with matching settings. Read back idle, queue 0. |
| Mac translator on 8900 and forwarder on 1236 | Stopped. Both ports closed. |
| Remote key file | Deleted after I granted the current user delete rights on that one file. My earlier read-only ACL had blocked deletion. |
| Remote start script | Deleted. |
| Mac key copies and key SHA file | Deleted. Log scan found no key value. |
| Remote agent instances | Eight finished read-only or narrow instances terminated. |
| **Residual** | `C:\Users\shutu\.orchestrator\_scratch\aio-transfers\plan-ex-ab-security-20261107`: `server.pid`, `server.stderr.log` (4,684 B), `server.stdout.log` (0 B). No key material. Kept as evidence, not deleted. |
| Untouched | The 2 Nov key file, the Bitwarden item, all models, and the LM Studio helper's original session. |

## Files in this folder

- `smoke.mts`: the runbook's smoke script, byte-for-byte.
- `smoke.run.log`, `smoke-fixture/`: run output, the agent log and the independent `npm test` log.
- `native-timing-lines.txt`: native timing lines for requests 1 and 2, with the request counts that matter.
- `translator-8900.log`, `tcp-forward.mjs`, `tcp-forward.log`: the translator failure and the forwarder used around it.
- `SEAL.json`: SHA-256 of each file above.
