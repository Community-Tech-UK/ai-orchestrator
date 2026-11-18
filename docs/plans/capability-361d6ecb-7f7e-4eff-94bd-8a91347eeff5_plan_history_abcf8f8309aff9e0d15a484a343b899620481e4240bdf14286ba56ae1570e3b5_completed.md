## Snapshot of capability-361d6ecb-7f7e-4eff-94bd-8a91347eeff5_history.md

# History: capability repair 361d6ecb (disposable question card)

Round evidence only. The plan's Status block points here. Active file: do not commit.

## Round 1, 16 November 2026 (queue worker)

### Reproduction (existing routes, read from the call path)

- Claude: `AskUserQuestion` is in `DEFAULT_DISALLOWED_TOOLS` (`src/main/cli/adapters/host-cli-tool-policy.ts`), applied in
  `claude-cli-argv-builder.ts` on every launch. The adapter's `emitAskUserQuestionInputRequired` can only run if the CLI
  emits the tool, which the flag prevents.
- Codex: no collaboration-mode wiring in `src/main/cli/adapters/codex`; `request_user_input` is unavailable in Default mode.
- OpenCode: the question tool needs a configured model; the evidence run got prose instead.
- Conclusion: no real provider can be made to ask on demand, so the card has to come from a test-owned agent. The renderer
  side (typed answers consumed by a question card, permission cards ignoring composer text) already exists and has specs
  (`chat-detail-question-answer.spec.ts`, `input-request-types.ts`); only the creation of a real card was missing.

### Design chosen (smallest bounded control)

A live-test-only session whose adapter is the real `AcpCliAdapter` over a scripted in-process agent. Gate: handlers exist
only when `isHarnessLiveTest()` (`live-test-context.ts`: private `/tmp/aio-lt-*` profile plus ownership receipt). Session
found by its private folder so first start, respawn and wake all reach the scripted adapter. Rejected alternatives: a fake
`claude` binary (large adapter surface, version probes), a child-process agent script (asar and signal-fence complexity,
real pid), a new provider type (91 files list providers).

### Live runtime check (worker, Windows PC dev app, port 9417, over CDP; opens no browser)

First build exposed two defects, both fixed:

1. The instance came up as provider `claude`, status `error`: `resolveCliType` falls back when OpenCode is not installed.
   Fixed in `instance-lifecycle.ts` (`resolveCliTypeForInstance` and the create path keep the requested provider for a
   fixture folder). Rebuilt: provider `opencode`, status `idle`, not YOLO.
2. The session stayed `busy` after every turn. App log showed `idle` then a later `busy` (normalised via `ready`). The
   scripted agent answered instantly, so the turn finished before the adapter emitted its own post-answer `busy`; a real
   agent takes longer. Fixed with a 25 ms answer latency in the peer; unit test pins that the turn does not end in the same
   breath as the answer.

Observed on the second build (before defect 2's fix): create returned an instance id; `sendInput` raised
`acp_elicitation:9000` with `questions: [{header: colour, options: [red, blue]}]`; `respondToInputRequired` with "blue" and
an `answered` receipt returned success, the transcript gained `Fixture answer received: {"colour":"blue"}`, and a
`decided` resolution event arrived. A "free-text" prompt raised `acp_elicitation:9001` with a question and no options;
"Ada Lovelace" was echoed as `{"name":"Ada Lovelace"}`. A "permission" prompt raised `acp_permission:9002`
(`acp_permission_request`, YOLO off) and "Allow once" gave `Fixture permission outcome: selected (allow)`.

Remove path, also live (second build): a foreign id returned `NOT_A_LIVE_TEST_QUESTION_SESSION`; a created session
removed with success and a second remove of it was refused; removing the first session succeeded; `listInstances` was
then empty. The preload bridge drops arguments to `createLiveTestQuestionSession`, so an extra field never reaches the
handler (the handler's own refusal of one is unit tested).

### Cleanup

The first (second-build) copy on the PC was closed over CDP (`Browser.close`; its debugging port stopped answering).
`dev-app.js stop` and `shell` could not reach the PC, so its data folder `/tmp/aio-lt-question-fixture` there and the local
state file for port 9417 were left; the runner's own expiry (20:45) covers the copy. The waiting `start --remote-only` for
port 9418 was killed by PID pattern and confirmed gone. Nothing was started on this Mac.

### After the fixes

Rebuilt copy could not be started to re-confirm defect 2's fix: the test Mac was at load 88 to 167 on 10 processors, and
the Windows PC accepted the connection but never sent its SSH banner (`Connection timed out during banner exchange`)
from this Mac, while its existing tunnel still answered, so this is a refusal to take new connections, not an outage. Not
treated as down. Starting on this Mac was not done (unattended run; global rule). `dev-app.js start --remote-only` was
left waiting for a free computer. See the livetest doc for what stays to be re-run.

### Gates run in the worktree

- `npm run typecheck`, `typecheck:spec`: exit 0 (before the last peer edit; re-run at the end, see below).
- `npm run lint` (ng lint): exit 0. `npm run lint:fast`: exit 0 (existing warnings only).
- `npm run check:ts-max-loc`: exit 0 (needed: `adapter-factory.ts` under 798 after moving the hook into the adapter module,
  new preload domain file instead of growing `instance.preload.ts`).
- `npm run verify:ipc`, `verify:architecture` (after `generate:ipc`, `generate:architecture`): exit 0.
- `npm run check:ui-hints`, `build:main`, `build:renderer`: exit 0.
- Targeted vitest: live-test-question peer, adapter, factory, handler specs (31 tests), plus adapter-factory,
  instance handler, live-test-context, instance-lifecycle and preload specs (260 tests): all pass.

## Out-of-scope findings

- The fixture instance shows `currentModel: "opus[1m]"` (the default model the resolver picks for an OpenCode session).
  Cosmetic; nothing sends a prompt to a model.
- `docs/plans/livetest-capability-repair-runbook.md` is untracked in the root checkout, not in the worktree, so its new
  table row lives only in the root copy.

## Round 3 (resume, 18 Nov 2026)

Parked because the checker's runtime probe found no free remote computer (Windows PC unreachable, test Mac load 17 to 30).
At resume: `list_remote_nodes` showed windows-pc and ct-test-mac both connected (PC latency 2 ms); the Mac host load was 70.
No code change. Re-ran in the worktree: `npm run test:quiet` on the four live-test-question specs, 31 tests passed
(ran on the Windows PC, exit 0); `npm run typecheck`, exit 0. The live re-confirmation of defect 2's fix was not run by me;
it stays with the checker's probe (livetest doc, check 1).
