# Dependency audit remediation implementation plan

> Execution: use the debugging, planning, verification-before-completion and independent task-completion-gate skills. Work in the existing checkout; do not create a branch/worktree, stage, commit or push.

**Queue worker status (31 October 2026):** worker implementation and focused verification finished; ready for independent queue verification. The queue coordinator owns the full suite, independent completion verdict and final rename. No linked spec exists in the plan or beside it. Historical results below are retained as history, not current verification.

**Goal:** Resolve the reported npm advisories and review install-script permissions without losing existing work or weakening security/test gates.

**Architecture:** Update direct dependencies to patched compatible releases, override WhatsApp's pinned Puppeteer dependency only after checking its used API, and replace the unmaintained ZIP extraction dependency while preserving the plugin installer's existing containment rules. Migrate Vitest's pool configuration to its patched major without changing test discovery, isolation or resource limits.

**Scope:** package.json, package-lock.json, Vitest configuration and required compatibility changes, plugin ZIP extraction and its tests, and explicit npm install-script policy. Existing staged and unstaged changes are unrelated and must be preserved. Baseline manifest/lockfile and audit are retained in `_scratch/audit-remediation/`.

## Acceptance and review focus

- Fresh npm audit reports no remaining findings, or any genuinely unfixable finding is explicitly explained with evidence.
- Graph authentication and callback lifetime tests still pass with MSAL 7.1.1 or newer patched 7.x.
- Zod >=4.6.6 is used by every installed consumer; IPC contracts and builds remain valid.
- Puppeteer no longer depends on extract-zip; WhatsApp can load its browser library on the supported Node/Electron runtimes. Do not open a local browser for verification.
- ZIP plugin imports still handle normal/nested archives and reject symlink, traversal and overwrite attacks.
- Vitest >=4.1.12 keeps the same test selection, isolated workers, bounded concurrency and heap ceiling; the slow tier stays serial.
- Install permissions are explicit and narrowly scoped; downloading unused browsers and donation scripts is unnecessary.

## Task list

- [x] Reproduce the audit, inspect dependency chains and retain the initial dirty-tree manifest/lockfile.
- [x] Inspect upstream API/engine changes and the real application callers; select patched versions and ZIP replacement.
- [x] Update dependencies/lockfile and preserve the installer's ZIP guards.
- [x] Migrate only the Vitest settings and compatibility changes required by the update.
- [x] Record explicit reviewed npm install-script decisions and verify warnings are cleared.
- [x] Worker: run focused tests, fresh audit, production/build audit gates, typechecks, lint, size/UI checks and main/renderer builds; retain full logs and actual exit statuses.
- [ ] Queue verifier: run the full quiet test suite against the final worktree-local install (expressly excluded from this worker’s instructions).
- [ ] Run a fresh independent completion-gate review; resolve actionable findings and repeat until PASS.
- [x] Worker: record final evidence and remaining live limitations.
- [ ] Queue coordinator: rename this plan `_completed` only after its verifier passes. The worker must not rename it.

## Evidence and decisions

- Initial `npm audit --json`: 10 findings (8 high, 2 moderate), retained at `_scratch/audit-remediation/audit.before.json`.
- Registry confirms Vitest 4.1.12 fixes both mocker advisories; no need to jump to Vitest 5.
- Registry confirms extract-zip 2.0.1 has no patched release. Existing plugin guard mitigates hostile entries, but removing the package is preferred to keeping an accepted advisory.
- No code has been committed or staged for this task.
- Updated direct dependencies: MSAL 7.1.1, Puppeteer Core 25.16.0, Zod 4.6.7, Vitest 4.1.12. WhatsApp's pinned Puppeteer is overridden to patched 25.16.x; its module loads and client constructs under supported Node without opening a browser.
- Removed extract-zip entirely. The plugin resolver uses yauzl 3.4.0 with the same path/symlink guard. Explicit FileHandle ownership awaits descriptor closure on both parser and extraction errors. Real archive tests cover nesting, directories, executable permissions, malformed data, traversal and symlink overwrite. Lifetime tests assert a real descriptor is closed on success, initial parse failure and iteration failure.
- MSAL 7 removed the custom interactive callback hook. Replaced that internal interface with public getAuthCodeUrl/acquireTokenByCode and MSAL-generated PKCE, state and nonce. The existing bounded callback transport now accepts form POST only, validates state and permits only response fields; callback data cannot select an authority. Focused tests include the real SDK's authorization/token path with an offline denied endpoint, not a claim of live sign-in.
- Replaced removed Vitest poolOptions with a root maxWorkers cap and per-project execArgv; slow tier remains serial. Both script launchers resolve the declared bin through the public package.json export. Callable/constructor test doubles were migrated without removing assertions, tests or timeouts. One indexing event assertion now waits for the already-asynchronous event instead of assuming four microtasks suffice.
- Simplified conflicting nested Undici overrides to major-version selectors, retaining patched v6/v7 consumers in their supported major. npm dedupe removed obsolete duplicate dependency branches. `npm ls --all --json` exits 0; install completes without the former peer warning.
- Version-pinned install approvals cover reviewed native/build packages. Puppeteer downloads and core-js donation postinstall are explicitly denied. `npm install-scripts ls --json` reports no pending approvals. Electron and all native dependency versions are unchanged from the initial lockfile snapshot.
- Current successful gates: fresh raw npm audit (0 findings), production/build audit scripts, main/renderer builds, production typecheck, lint, size and UI-hint ratchets, exports check, focused Graph/plugin/renderer/worker and migration batches. Spec typecheck passes. The first final full run exposed one remaining constructor mock, now fixed and passing, plus a standalone executable test that passes unchanged with the repository-pinned Node 24.22.1; Homebrew Node lacks its required SEA fuse. The final canonical verification now runs with the pinned runtime. Full logs live under `_scratch/audit-remediation/` and `_scratch/test-run.audit-*.log`.

- Pinned-runtime canonical checks all passed except the full runner exit: every assertion passed, but the maintenance test removed its workspace before its background iteration finished. Its teardown now observes and awaits the actual runLoop promise after cancellation, preserving all assertions. Focused before/after evidence confirms the late write warning disappears. Final spec/lint/full verification is rerunning.

- A second suite run exposed the same unfinished-loop teardown in the convergence integration fixture. Vitest detectAsyncLeaks reproduced nine pending resources before its teardown fix; both affected fixtures now pass with zero reported leaks, unchanged assertions and no logging/error suppression. Final spec/lint/full run is pending. During the Harness restart another session committed the pre-existing checkout changes as `October updates`; this task did not create that commit. Remaining amendments stay unstaged.

## Queue continuation, 31 October 2026

- Starting checkout was clean at `507d1592d`; the earlier MSAL/Puppeteer/Zod/Vitest and ZIP work is already in its ancestry (`d21fdce4b`). This worker has not committed, staged, switched branches or created a checkout.
- Reproduction against the current registry returned 36 findings (2 high, 34 moderate), rather than the historical zero. Full JSON: the assigned worktree's `_scratch/audit-remediation/audit.log`. Root causes: newly reported follow-redirects, joi, Glob and Minimatch advisories.
- Updated Glob 13.0.6 to 14.0.3 after inspecting both application/tool callers (`indexing-service.ts` and `lint-colors.js`), preserving their named `glob`/`globSync` APIs. Its required Path Scurry becomes 3.0.0 and nested Minimatch 11.0.3. Updated follow-redirects 1.16.1 to 1.16.2 and joi 18.2.9 to 18.3.1 within their existing parent ranges. No native dependency or Electron version changed.
- The supplied node_modules entries linked to the root checkout; `npm ls --all --json` exposed the resulting extraneous/missing graph. Replaced them with a worktree-local `npm ci --ignore-scripts --no-audit --no-fund`; ran approved build scripts separately to avoid running the root postinstall's global hook/ignore installers. Installed dependencies remain in the queue worktree for the verifier. Subsequent dependency-tree check exits 0 and install-script policy has no pending entries.
- Before these amendments, focused Graph/plugin/pool/heap/audit/lifetime checks and indexing checks passed, as did both typechecks, lint, size/UI checks, export/contracts checks, generators and main/renderer builds. These initial checks used the supplied linked dependencies; they are being rerun against the local exact install and changed lockfile. All fresh final commands are pinned to Node 24.22.1 through their recorded environment.
- Post-update raw audit has no high or critical findings; remaining moderate findings are being assessed separately. No security allowlist or test gate has been weakened.
- Receipts and complete command logs are in `_scratch/audit-remediation/`; live account checks remain in the existing adjacent `_livetest.md`. The worker will not run the full test suite or issue an independent completion PASS; those are the queue verifier's required work.

### Final worker evidence, 31 October 2026

- Worker code changes are ready for independent verification. [Handoff report](2026-10-25-dependency-audit-remediation_evidence/report.md), [command receipts](2026-10-25-dependency-audit-remediation_evidence/command-receipts.jsonl) and `2026-10-25-dependency-audit-remediation_evidence/seal.json` retain the delivered-state evidence. All `handoff-*` commands exit 0.
- The final targeted batch passes: 34 files / 358 tests, covering Graph/callbacks, plugin archive guards, indexing, pool/heap, dependency compatibility, loop teardown and selected migrated renderer fixtures. Both TypeScript checks, lint (including the changed script test), size/UI checks, exports/contracts, generators/IPC verification and main/renderer builds pass against the settled lockfile. No tracked generator output changed.
- Final production audit: zero findings. Final raw full audit: 32 moderate propagated findings from one Minimatch advisory, all confined to build tooling; zero high/critical. Both unchanged audit policy gates pass. The report records registry evidence that compatible patched old-major/parent releases are unavailable, the breaking old callable/default APIs, and why the proposed old builder/parser downgrades violate the repository’s security/TypeScript requirements. No blanket override or security exception was added.
- Applied a narrow `readdir-glob` → Minimatch 11.0.3 override to clear WhatsApp’s remaining production chain. New real-directory ZIP test preserves nested and hidden session files and exact contents; it passes before and after the override. `npm ls --all --json` exits 0, install-script approvals have no pending entries, and a final lockfile-exact dry run succeeds.
- Offline WhatsApp/Puppeteer construction passes under Node 24.22.1 and Electron 42.11.18 (embedded Node 24.19.0), without opening a browser. Zod is 4.6.6/4.6.7 throughout; extract-zip is absent. Electron/native dependency versions are unchanged. Dependencies and prepared native binaries stay in the assigned queue worktree for its verifier.
- Full suite and independent completion PASS are not claimed: the queue verifier owns both. The existing live-test document still records four account/consent/pairing checks that require the intended rebuilt app and external services. The coordinator owns the final rename; this plan remains active and untracked at its original root-checkout path.
- Worker self-review found no further actionable issue. Remaining build warnings are the existing renderer bundle advisory budget and Electron punycode deprecation; no suppression was added. Disposable generated output/cache are removed after evidence sealing, with the exact result in the cleanup receipt.
