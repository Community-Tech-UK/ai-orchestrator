# Windows Chrome startup routing

Status: implementation ready for the independent queue verifier (2026-10-13). This plan remains untracked and keeps its active filename. Full-suite verification and the independent completion gate belong to the queue verifier. A rebuilt-coordinator live check is recorded separately below.

## Cause

`assertRunOnNodeUsesWorkerBrowserSurface` runs at the start of `spawnRemoteInstance`. `namesExplicitSharedSessionSurface` treats any protected noun anywhere in the prompt as paired with any session marker anywhere else. `existing startup entries` supplies `existing`, and `chrome.exe` supplies `chrome`, so a per-user Startup shortcut is refused as shared-tab access. A closed safety sentence that names tabs also satisfies `hasSharedTabIntent` when the prompt also says Chrome and uses a verb such as inspect.

Reproduced by calling `assertRunOnNodeUsesWorkerBrowserSurface` (the function `spawnRemoteInstance` calls first) with the startup prompt. Result: the Browser Gateway refusal. The same call still allows Windows work that names no browser surface, worker-managed Chrome, and native-host relay recovery, and still refuses an existing logged-in Chrome tab.

## Repair

Before that classification, remove only:

- `existing` bound to startup, Run, registry, or filesystem configuration nouns
- `user's` / `users'` bound to a Startup folder or Startup shortcut
- a finished safety sentence that leaves running browsers and tabs untouched, or says not to touch or access tabs, and does not continue into another action

Do not remove those safety sentences when the prompt negates them (`do not leave … untouched`). Do not consult `requiresBrowser`. Do not allow a prompt just because it mentions Startup, PowerShell, or Windows.

Shared-tab access, and startup wording combined with shared-tab access, still throw. Relay recovery and worker-managed Chrome stay on their existing paths.

## Verification

- [x] Narrow OS-configuration exemptions; no `requiresBrowser` bypass. Existing integration tests prove startup-only admission and mixed/shared-tab refusal.
- [x] Finished safety sentences allowed; negated safety and continuations retain browser intent. Six newly reproduced continuation bypasses now refuse.
- [x] Native-host relay recovery and worker-managed Chrome retain their existing paths, covered by the focused integration suite.
- [x] Focused routing/provider tests, `tsc`, `typecheck:spec`, lint, max-loc, `build:main`, and `build:renderer` pass.
- [x] Alias and IPC generators run; generated tracked output is unchanged.
- [x] On `windows-pc`, create/reuse one ordinary per-user Chrome Startup shortcut with empty arguments and read it back, without launching Chrome or rebooting.
- [ ] Independent `task-completion-gate` review and full `test:quiet` run: queue verifier responsibility. The worker did not run the full suite, as instructed.

Deferred rebuilt-app verification: [2026-10-07-windows-chrome-startup-routing_livetest.md](2026-10-07-windows-chrome-startup-routing_livetest.md).

## As-built notes — 2026-10-13

### Investigation and implementation

The supplied queue checkout already contained the main OS-configuration masking implementation and startup regression cases in `orchestrator-tools-step.spec.ts`. The plan has no linked spec, and a repository/root-doc search found no companion spec. Those existing repairs were verified rather than duplicated.

Production routing remains wired at the first line of `spawnRemoteInstance` in `src/main/app/orchestrator-tools-step.ts`. This worker changed only `src/main/app/run-on-node-support.ts` and added `src/main/app/run-on-node-startup-routing.spec.ts`.

Two red/green reproductions exposed residual safety-mask failures:

1. A semicolon was treated as a finished safety sentence. `Inspect existing startup entries and create a chrome.exe Startup shortcut. Leave running browsers and tabs untouched; then inspect them.` was admitted. The mask now accepts only sentence-ending punctuation or end of input, retaining semicolon-linked clauses.
2. A following sentence could act on the removed browser antecedent: `Leave running browsers and tabs untouched. Then inspect them.` was admitted. The mask now retains the antecedent when the immediately following sentence starts a recognized browser action on `it`, `them`, `these`, `those`, `its`, or `their`, with optional connecting words. A next sentence explicitly reading the shortcut or registry values still passes.

Ruling: a semicolon joins clauses and cannot prove a finished standalone safety sentence. Immediate pronoun continuations also do not prove a standalone safety instruction. Preserve those words for the existing fail-closed classifier. The tradeoff is conservative refusal of semicolon-linked startup prose; a complete safety sentence plus an explicit configuration read-back remains supported. No broad Startup/PowerShell/Windows allowlist was added, and native-host recovery parsing was not changed.

### Verification evidence

Evidence directory in the implementation worktree:
`/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-07-windows-chrome-star-6070ab/_scratch/windows-chrome-startup/`.

- Initial semicolon regression run: 3 of 12 tests failed because the real routing assertion did not throw; log `_scratch/test-run.pid-64157.log`.
- Next-sentence regression run: 3 of 17 tests failed for the same admission error; log `_scratch/test-run.pid-2340.log`.
- Final focused command: `rtk npm run test:quiet -- src/main/app/run-on-node-startup-routing.spec.ts src/main/app/orchestrator-tools-step.spec.ts src/main/app/run-on-node-provider-selection.spec.ts` — exit 0, 3 files / 1,554 tests passed; log `_scratch/test-run.pid-13335.log`. The new file has 17 cases; the existing integration suite also covers `requiresBrowser: false` mixed/shared-tab refusal, managed Chrome and relay recovery.
- `rtk proxy npx tsc --noEmit` — exit 0 (`tsc.log`).
- `rtk proxy npm run typecheck:spec` — exit 0 with the required 8 GiB heap ceiling (`typecheck-spec.log`).
- `rtk proxy npm run lint` — exit 0, all files pass (`lint.log`).
- `rtk proxy npm run check:ts-max-loc` — exit 0 (`max-loc.log`); existing legacy tolerance notices remain.
- `rtk proxy npm run build:main` — exit 0, asset sync and preload bundling completed (`build-main.log`).
- `rtk proxy npm run build:renderer` — exit 0, production Angular bundle generated (`build-renderer.log`). Renderer sources were unchanged by the later continuation fix.
- `rtk npm run generate:aliases` and `rtk npm run generate:ipc` — exit 0; no generated-file diff.
- `rtk git diff --check` — exit 0.
- Author review checked the final diff, classifier call path, mask ordering, negation handling, test assertions and generated-file status. It found the next-sentence bypass and fixed it before this handoff. This is not an independent completion-gate verdict.

### Windows startup and current running-app evidence

Browser Gateway health and `list_remote_nodes` both confirmed `windows-pc` connected, with a fresh deliverable remote extension channel. All worker operations targeted `windows-pc`; no Mac browser/desktop was used.

The current coordinator admitted the original startup-only prompt with `requiresBrowser: false`. Explicit Claude and Copilot attempts reached provider admission but returned `cli_not_signed_in`; omitting the provider let the app select an authenticated advertised provider. No login or credential entry was performed.

The authorized configuration task reported no equivalent shortcut beforehand and created:

- Shortcut: `C:\Users\shutu\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Google Chrome.lnk`
- Target: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Arguments: empty
- Equivalent empty-argument shortcut count: 1

A separate read-only worker task inspected the actual Startup shortcuts and HKCU Run entries, copied the shortcut into the allowlisted transfer area, and saved its verification script and JSON evidence. The coordinator downloaded all three through `download_from_node`. The JSON read-back records target-file existence, one equivalent shortcut, and no Chrome HKCU Run entries. The downloaded `.lnk` bytes independently decode to the same target, have no `HasArguments` flag, and use normal show command 1. Decoding followed Microsoft's [Shell Link format](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/4d25bbad-09b7-4322-8c0a-521d268481bb), [LinkFlags](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/ae350202-3ba9-4790-9e9e-98935f4ee5af) and [LinkInfo](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/6813269d-0cc8-4be2-933f-e96e8e3412dc) definitions.

Retained files under the evidence directory: `Google Chrome.lnk`, `windows-evidence.json`, `verify.ps1`, and `shortcut-byte-readback.json`. The shortcut is 1,345 bytes with SHA-256 `5b584d5901e68e5fffb11c13551585f8326cbdd7973c3b5defc0fe9185ad3c83`. Remote evidence remains at `C:\Users\shutu\Documents\Work\_scratch\aio-startup-verification\`.

Both disposable worker instances were terminated after evidence collection. Chrome was not launched and Windows was not rebooted. The existing coordinator has not been reloaded with this worker's additional continuation fixes; that precise remaining runtime check is in the linked livetest. No commit, branch switch, worktree creation, document rename or integration was performed by the worker.
