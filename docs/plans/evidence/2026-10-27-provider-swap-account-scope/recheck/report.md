# Provider-swap account scope: verifier follow-up, 2026-10-27

All three live checks pass in the isolated rebuilt dev app. This follow-up supplies the previously missing composer observation. The original restart and seventh-session evidence remain accepted, with their seals and source fingerprints checked again. Independent queue verification remains pending. No production source, test, expectation, production chat or production setting was changed.

## Composer result

`composer-runtime.json` is the dated DOM/IPC receipt. At 14:20:36 UTC the real composer displayed OpenCode/MiMo and account ComTechSpare (`comtechspare-f7a6`) with the pre-existing synthetic user message rendered. The automated test clicked that composer's compact model picker, chose its Codex provider tab and selected the available `gpt-6-astra` row. It did not call `changeModel` directly or assign a renderer/store value.

At 14:20:43 UTC the actual runtime was idle on Codex, `gpt-6-astra`, destination account `legacy`, routing source `default`. The composer chip read Codex / GPT-6 Astra. Its account text read CodexSUAS, and the actual HTML select value was `legacy` with CodexSUAS and CodexComTech as options. The original user message and real provider-change system notice remained rendered; user-message IDs survived and no removed-account error appeared. At 14:20:47 UTC a real Codex response recalled the earlier fact. The source and destination account IDs differed. These assertions cover check 1's account/provider display, notice, conversation retention and continuation.

## Runtime and method

The automated offscreen Electron test ran from the assigned queue worktree using `/tmp/aio-lt-queue-c260c2ee` and debugging port 9832. A local static server served the production-built Angular renderer on localhost:49832. Window creation alone was replaced with a hidden offscreen BrowserWindow to avoid touching the local desktop; the real preload, WindowManager event transport, IPC handlers, routing, adapters and persistence ran unchanged. DOM values came from the real composer components; no store seeding, mocked provider, patched IPC, forced change detection or direct account-chip mutation was used. Styling and the installed app's window were not checked, and are not needed for this check's alternative MiMo-chat procedure.

Focus emulation was enabled before DOM assertions and retained throughout the successful connection. The page reported `hidden: false` and visible both before and after switching. The additional visibility-override command was unsupported. Browser Gateway health reported a fresh/deliverable Windows worker channel; no everyday Chrome tab or visible desktop window was controlled.

The isolated profile mirrored existing provider account metadata and pool policy only, with the existing named MiMo account preferred for the disposable test. No secret values were copied or printed. The destination used the existing default/legacy Codex sign-in. Selecting coordinator mode changed only the disposable profile.

## Corrections and failed attempts

The numeric-loopback page origin was rejected by the real sender trust guard (`ipc-main-handler.ts:173`); changing the test origin to the normal localhost address resolved it. The next probe stopped before the composer because the fresh profile's computer role was unset. The successful probe selected coordinator role through the disposable app's own role choice. Those attempts are retained separately and are not passes or product defects.

`sendInput` awaited the live source turn. A separate bounded test connection interrupted only the disposable source instance, recorded in `source-send-interrupt.json`; the successful probe then continued. Its later duplicate interrupt returned false because the first interrupt had already settled that turn. The composer switch and Codex continuation then succeeded normally.

The first aio-mcp executable build used Homebrew Node, which lacks the required executable fuse. Repeating it with the repository-pinned Node version succeeded. The failed command and successful correction both remain in the command receipts.

## Verification and handover

Current main, renderer and pinned-Node aio-mcp builds, both typechecks, lint and focused quiet tests exited zero. The focused result was 5 files / 128 passed, covering account swap, routing, limiter, composer toolbar and provider account chip. The original source/evidence digests all match (`previous-evidence-validation.json`). The full suite and slow tests were not rerun for this documentation/evidence-only follow-up on a shared host; no product or test code changed. No new application defect was reproduced, so no remediation entry is warranted.

The owning livetest document is updated only in the root checkout, as explicitly required. `handover.json` ties that absolute path and digest to this branch's evidence. Each current evidence link in the owning document has a portable landing link and a working-copy alternative usable now. The queue coordinator already harvests root documents through `prepareClosedDocuments` and builds them into the landing commit through `buildLandingCommit` (campaign runbook section 5). No document copy or rename is required from this worker. The evidence-local `.gitignore` exception preserves the small existing command logs that the global log ignore had excluded from the checkpoint; this also keeps the original seal independently checkable after landing.

All disposable instances were terminated. The successful Electron main process exited normally with code zero, and its PID was confirmed gone. Earlier failed harness launches also exited normally. Runtime/profile/compile artifact removal and final listener/Git checks are recorded in `cleanup-receipt.json`; pre-existing shared dependency/cache symlinks are preserved. No commit, stash, branch change, worktree creation or document rename was performed. The coordinator owns independent verification and closure.
