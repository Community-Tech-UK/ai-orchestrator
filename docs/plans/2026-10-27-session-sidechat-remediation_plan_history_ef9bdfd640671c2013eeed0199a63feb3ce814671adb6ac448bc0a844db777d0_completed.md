## Snapshot of 2026-10-27-session-sidechat-remediation_history.md

# Session sidechat remediation: history

## Resume round — 2026-11-11 (after waiting for provider usage)

Findings on arrival: the branch `queue/2026-10-27-session-sidechat-re-16b98b` has no commits beyond its base `8bdce3be0`. The remediation code is already an ancestor of HEAD (`1b71b7719`, code-only hand-merge of the parked `022b2b` branch). Every plan checklist item was already ticked, so there was nothing further to implement. Spot-checked that HEAD holds the LT-723 execution-location routing (`src/main/chats/side-chat-parent-resolver.ts` uses `executionLocation`), the LT-711 retained approval bus, and the LT-712 history badge component.

Checks run in the worktree (no code changed by this round):

- `npm run test:quiet` on the 15 spec files changed by `1b71b7719` plus `claude-cli-argv-builder`: 16 files, 315 tests passed.
- `npm run checks -- "npm run typecheck" "npm run typecheck:spec" "npm run lint" "npm run check:ts-max-loc" "npm run check:ui-hints"`: all exit 0 (run on the Windows PC).
- Not run here by design: full suite, `build:main`, `build:renderer` (verifier owns these).
- Generators: no source changed, so none needed.

Live-test documents: `2026-10-27-session-sidechat-remediation_livetest.md` and `2026-10-02-session-sidechats_livetest.md` have no open checks; no deferrals.

Plan edit: replaced the loose "Status:" paragraph with a `## Status` block.


- Evidence/report/seal/command receipts: [worker bundle](../../.aio-review/2026-11-03-session-sidechat-remediation-022b2b/report.md). All test profiles, processes, compiled runtime and caches created for this task are removed after sealing; dependency installs remain for the verifier. No commit, stash, branch/worktree operation, push, deployment or completion rename.



- LT-723: live `executionLocation.nodeId` now supplies inherited worker routing, parent context provenance and renderer parent references. Live local provenance overrides stale caller metadata. Chat-backed, ledger-backed and standalone parents follow the same rule. The corrected renderer type comment distinguishes supervision from the execution machine. No wire or persistence schema changed.
- Test doubles now model `executionLocation` instead of filling a supervision field with a remote-machine identifier. Regression cases distinguish the two identifiers, cover all parent-context sources, keep local parents local, retain a remote route after parent termination, and cover chat-backed parents. Tests were changed after the before/after real provider probe established the behaviour.
- Restored the tracked source acceptance document and reconciled it with the coordinator's longer historical campaign record. It remains active/untracked in this checkout because the current HEAD deleted it and active live-test documents must not be staged; it is present on disk for the next queue checkpoint. No history or acceptance criterion was removed.
- The first pinned focused repeat timed out in an unchanged archive test during observed host load 119/66/35. A later one-fork focused run passes with every assertion retained; the isolated unchanged archive case also passes. No timeout, runner, assertion or test suppression was changed. A production renderer build caught the renderer/shared instance-type mismatch during repair; the helper now uses the renderer's own type. Failed attempts remain historical, not green evidence.
- Full independent queue acceptance is not claimed. The worker leaves source, documents and reports for the next verifier, without committing, switching branches, staging active documents or renaming anything `_completed`.

