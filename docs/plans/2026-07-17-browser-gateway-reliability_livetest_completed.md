# Browser Gateway Reliability Hardening — Live Test Checklist

## Status — completed 2026-09-27

Open: 0 · Closed: 5 · Failed: 0 · Transferred: 1

All agent-runnable reliability checks now pass. The sole destructive authenticated-session check was
removed from this document and transferred to
[RES-002 in the consolidated human/external checklist](2026-09-27-livetest-human-external-residuals_livetest.md#res-002--authenticated-spa-stale-session-and-save-rejection-detection).

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching active remediation implementation record. A pending or unrun
> check is not automatically a defect, but a *reproduced* one belongs there, not only here.
> Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-07-17-browser-gateway-reliability_plan_completed.md](2026-07-17-browser-gateway-reliability_plan_completed.md)

## Completion evidence

| Check | Result | Date | Evidence |
| --- | --- | --- | --- |
| 1 — `extractionHint` end-to-end | PASS | 2026-09-24 | With `browserAuxExtractionEnabled=false`, the live shared-tab snapshot accepted `extractionHint`, returned raw text and never produced `invalid_browser_gateway_rpc_payload` (audit `46e4d857…`). With the setting enabled, the same request returned only a distilled contract value and deadline matching the raw capture (audit `73538dab…`). The setting was restored to `false` and read back. |
| 2 — deferred-tool parity across real MCP reconnect | PASS | 2026-09-20 | Fresh deferred instance `cvcrrjv0h` initially listed 10 tools without `browser.evaluate`; tool search revealed it and emitted `tools/list_changed`; a new forwarder process using the same instance id listed 12 tools including `browser.evaluate` on its first `tools/list`, without another search. Health reported schema parity and no `revealRestoreFailed`. |
| 3 — handle survival across a worker blip | PASS | 2026-09-06 | James accepted split live evidence from two natural disconnects: one supplied `node_disconnect → node_reconnect` plus suspension/restoration and same-handle reuse; the other supplied fail-fast `browser_extension_unreachable` and `stale:true` during the drop. Both exercise the same stateless suspend/restore path. |
| 5 — live health contract, including old bridge skew | PASS | 2026-09-20 | Current sessions reported protocol 1, matching surface and no missing tools. A bridge built from commit `83cfda14` reported 42/46 tools, `schemaMatch:false`, the four expected missing tools, the rebuild warning and both `contract_mismatch` and `tool_surface_diff`; the stale binary was discarded. |
| 6 — sentinel scan cost and stability on a heavy page | PASS | 2026-09-27 | On a fresh, unauthenticated Angular Material examples tab on `windows-pc`, ten read-only baselines all succeeded in 29–110 ms. Two consecutive ten-write bursts against the empty public demo input completed **20/20**, each write verified, in 65–84 ms. No receipt loss, extension fault or renderer instability occurred. After the deliberate 31-call microburst hit the gateway's expected RPC rate limit on the first cleanup attempt, the limiter window cleared; cleanup succeeded (audit `a3a53706…`) and query `5aa87057…` read the field back as empty. Only the disposable tab was closed. |

## Historical defects and corrections retained by reference

- **LT-543:** the old expectation that the `aio-mcp` SEA would write “Restored previously revealed
  browser tools” to `app.log` was unobservable by design because that process had neither file nor
  console logging enabled. Functional restore evidence above replaces that impossible log clause.
- **LT-544:** the 2026-09-20 extension channel reported healthy while commands timed out. By
  2026-09-24 the `windows-pc` channel refreshed inventory and executed snapshot, find/open and query
  commands; the 2026-09-27 bursts add 32 consecutive successful live extension operations after
  limiter recovery.
- The isolated 2026-09-24 one-off `browser_extension_command_receipt_missing` did not recur: a
  second 10/10 burst passed then, and both new 10/10 bursts passed on 2026-09-27.

## Cleanup

The Angular Material page was opened as a new disposable Windows tab, no form was submitted, its
only edited demo field was restored to the empty value and verified, and only that tab was closed.
No authenticated page or business data was touched.
