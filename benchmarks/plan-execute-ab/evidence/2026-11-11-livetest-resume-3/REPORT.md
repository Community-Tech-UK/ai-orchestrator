# Local pilot livetest resume 3 — 2026-11-11

Receipt for the dated section "Evidence run — 2026-11-11 (resume 3, Plan Queue worker)" in the livetest document.

- Branch has no commits ahead of main (HEAD e42966506).
- `list_remote_nodes`: windows-pc connected, 0 active instances. `auxiliaryLlmRoutingMode` = `local-first`.
- A2 not started: key transfer still refused by the upload route (see resume 2). No key file created, nothing started on Windows, no inference, no cloud call.
- Code check: `speed-gate.ts:19` (30,000-token minimum), `speed-gate.ts:209` (no decision below it); no `promptEvidence` field anywhere in `benchmarks/plan-execute-ab/*.ts`.
- Next free register id: LT-1018 (none added).
- Nothing running, nothing to clean up.
