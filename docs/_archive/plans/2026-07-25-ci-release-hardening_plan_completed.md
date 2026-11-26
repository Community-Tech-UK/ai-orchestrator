# CI and Release Hardening Implementation Plan

> **For agentic workers:** Implement inline in the current session. Do not
> commit or push unless James explicitly asks. Steps use checkbox (`- [x]`)
> syntax for tracking.

**Goal:** Restore green CI and make stable releases fail early unless their
dependencies, provenance, tests, packages, signatures, and asset matrix are
verified, while keeping external repository policy explicit and
least-privileged.

**Architecture:** Keep dependency security, unit/slow test isolation, CI
orchestration, and release admission as separate gates with explicit contracts.
Use `package-lock.json` as the fast audit input, the existing slow Vitest tier
for real heap I/O, GitHub's API for release provenance/policy admission, and
the existing build matrix plus asset validators for platform publication.

**Tech Stack:** npm 11 lockfile/audit, Vitest 3, Node 24/V8 heap snapshots,
GitHub Actions, GitHub CLI/API, Electron Builder 26, TypeScript.

## Global Constraints

- Preserve all unrelated dirty-tree changes.
- Do not commit, push, tag, publish a release, or mutate repository settings.
- Keep every active plan/spec untracked.
- Do not weaken the production security audit.
- Keep one real heap-snapshot write in CI, isolated in the slow tier.
- Keep existing signing, notarization, packaged-startup, asset-name, manifest,
  checksum, and duplicate safeguards.
- Only the publish job may have `contents: write`.

---

### Task 1: Repair and expose the production dependency security gate

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: npm's audit service and lockfile v3 dependency graph.
- Produces: `npm run audit:production`, a zero-install, lockfile-only hard gate.

- [x] **Step 1: Add the audit command before updating dependencies**

Add to `package.json#scripts`:

```json
"audit:production": "npm audit --package-lock-only --omit=dev --audit-level=high"
```

- [x] **Step 2: Run the new command and verify RED**

Run:

```bash
rtk npm run audit:production
```

Expected: exit non-zero with five high-severity production findings across
`brace-expansion`, `builder-util-runtime`/`electron-updater`, `fast-uri`, and
`js-yaml` (plus the low `dompurify` finding).

- [x] **Step 3: Refresh only vulnerable dependency paths**

Start from the existing lockfile and update only the affected production paths
without lifecycle scripts:

```bash
rtk npm update --package-lock-only --ignore-scripts \
  dompurify electron-updater fast-uri js-yaml whatsapp-web.js
```

Use version- and parent-scoped overrides where their public major stays
compatible:

```text
brace-expansion@^5 -> 5.0.8
@discordjs/rest undici -> 6.28.0
discord.js undici -> 6.28.0
```

Do not force `brace-expansion` v5 into v1/v2 consumers. Inspect `package.json`
and `package-lock.json`; reject unrelated direct-dependency changes. The
resolved production graph must contain:

```text
electron-updater >= 6.8.9
builder-util-runtime >= 9.7.0
dompurify >= 3.4.12
fast-uri > 3.1.3
js-yaml >= 4.3.0
brace-expansion 5.0.8
```

`whatsapp-web.js` requires the callable CommonJS Archiver 7 API, but the fixed
Archiver 8 package exports classes. Add
`packages/archiver-compat/package.json` and `index.cjs` as a private workspace
package named `archiver@7.0.1`. It must preserve `create`, `registerFormat`, and
`isRegisteredFormat` while delegating built-in formats to an
`archiver-modern` alias of `archiver@8.0.0`.

- [x] **Step 4: Run the audit command and verify GREEN**

Run:

```bash
rtk npm run audit:production
rtk npm ls --omit=dev --all
rtk npm ls brace-expansion builder-util-runtime electron-updater dompurify fast-uri js-yaml --all
```

Expected: audit and both tree inspections exit `0`; the graph shows patched
versions at every affected production path and no invalid override.

- [x] **Step 5: Prove the strict install contract**

Run:

```bash
rtk npm ci
```

Expected: exit `0` without `--legacy-peer-deps`.

---

### Task 2: Isolate the real heap snapshot from normal unit shards

**Files:**

- Modify: `src/main/diagnostics/heap-snapshot.spec.ts`
- Create: `src/main/diagnostics/heap-snapshot.e2e.spec.ts`

**Interfaces:**

- Consumes: real `writeHeapSnapshot(directory)` behavior and
  `vitest.slow.config.ts`'s `*.e2e.spec.ts` inclusion contract.
- Produces: cheap unit coverage in normal shards and one bounded real snapshot
  smoke in the isolated slow tier.

- [x] **Step 1: Preserve the reproduced RED evidence**

The pre-change command already ran:

```bash
rtk env AIO_TEST_NO_CACHE=1 AIO_TEST_SUMMARY=0 npm run test:quiet -- --shard=4/4
```

Expected/observed: one failure at `heap-snapshot.spec.ts:51`,
`Cannot create a string longer than 0x1fffffe8 characters`.

- [x] **Step 2: Move the real behavior test to the slow tier**

Keep `getHeapUsageSummary` and collision tests in the unit spec. Create the
slow spec with its own temporary-directory cleanup and the existing production
call:

```ts
const result = writeHeapSnapshot(dir);

expect(fs.existsSync(result.filePath)).toBe(true);
expect(result.filePath.endsWith('.heapsnapshot')).toBe(true);
expect(result.fileSizeBytes).toBeGreaterThan(0);
expect(result.heapUsedBytes).toBeGreaterThan(0);
```

- [x] **Step 3: Replace the unbounded read with a fixed buffer**

In the slow test, use:

```ts
const descriptor = fs.openSync(result.filePath, 'r');
try {
  const buffer = Buffer.alloc(32);
  const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
  expect(buffer.toString('utf8', 0, bytesRead).trimStart().startsWith('{')).toBe(true);
} finally {
  fs.closeSync(descriptor);
}
```

This assertion must never call `readFileSync` on the snapshot.

- [x] **Step 4: Verify unit and slow placement**

Run:

```bash
rtk npm run test:quiet -- src/main/diagnostics/heap-snapshot.spec.ts
rtk npm run test:slow -- src/main/diagnostics/heap-snapshot.e2e.spec.ts
```

Expected: unit spec passes without writing a real snapshot; slow spec writes,
validates, and removes one real snapshot.

---

### Task 3: Specify the hardened workflow contracts

**Files:**

- Modify: `scripts/__tests__/release-workflow.spec.ts`

**Interfaces:**

- Consumes: parsed `.github/workflows/ci.yml` and
  `.github/workflows/release.yml`.
- Produces: regression coverage for early security, action pinning, release
  provenance/policy admission, strict install parity, and no-overwrite
  publication.

- [x] **Step 1: Add parsed workflow shapes**

Extend the local workflow types so tests can read:

```ts
interface WorkflowStep {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}
```

- [x] **Step 2: Add the action-pin regression test**

Collect every `uses` value in both workflows and assert the parsed reference is
a full SHA and the source line has a readable version comment:

```ts
expect(actionRefs.length).toBeGreaterThan(0);
for (const actionRef of actionRefs) {
  expect(actionRef).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
}
```

The production break caught is a workflow executing a newly moved third-party
tag without this repository reviewing the new commit.

- [x] **Step 3: Add CI gate tests**

Assert that:

```ts
expect(ciWorkflow.jobs.security).toBeDefined();
expect(ciWorkflow.jobs.security?.steps?.at(-1)?.run)
  .toBe('npm run audit:production');
expect(ciWorkflow.jobs.quality?.steps?.some(
  (step) => step.name === 'Security audit',
)).toBe(false);
expect(ciWorkflow.jobs['macos-smoke']?.needs)
  .toEqual(['quality', 'security', 'test']);
```

Also assert the model-catalog command handles drift as an explicit warning
instead of `continue-on-error`.

- [x] **Step 4: Add release admission tests**

Assert top-level release permissions are exactly:

```ts
{ actions: 'read', contents: 'read' }
```

Assert preflight contains named steps that:

```text
Refuse an existing GitHub Release
Require the tagged commit on main
Require successful CI for the tagged commit
Validate release tag
Audit production dependencies
Install dependencies
```

Verify their order places repository/provenance/audit checks before
installation, and that the build job still needs preflight.

Also assert that preflight does not call the Administration-protected
`immutable-releases` endpoint and does not receive a repository secret solely
for policy inspection.

- [x] **Step 5: Add install and publication tests**

Assert every dependency-install step in `release.yml` is exactly `npm ci`,
none contains `legacy-peer-deps`, and the publish action has:

```yaml
overwrite_files: false
fail_on_unmatched_files: true
```

- [x] **Step 6: Run the workflow spec and verify RED**

Run:

```bash
rtk npm run test:quiet -- scripts/__tests__/release-workflow.spec.ts
```

Expected: failures name missing security job, movable action refs, missing
release admission checks, legacy install drift, and overwrite policy.

---

### Task 4: Harden CI and release workflows

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**

- Consumes: `npm run audit:production`, GitHub Actions metadata/API, existing
  build matrix and release validators.
- Produces: early CI security feedback and fail-closed release admission.

- [x] **Step 1: Pin every external action**

Replace movable refs with the reviewed SHAs and version comments:

```yaml
actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
softprops/action-gh-release@3d0d9888cb7fd7b750713d6e236d1fcb99157228 # v3
```

- [x] **Step 2: Add the independent CI security job**

Add:

```yaml
security:
  name: Production Dependency Audit
  runs-on: ubuntu-24.04
  timeout-minutes: 5
  permissions:
    contents: read
  steps:
    - name: Checkout
      uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
    - name: Setup Node
      uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
      with:
        node-version-file: .nvmrc
        cache: npm
    - name: Audit production dependencies
      run: npm run audit:production
```

Remove the quality job's late audit and make `macos-smoke.needs` equal
`[quality, security, test]`.

- [x] **Step 3: Make external drift an actual warning**

Change the model-catalog step to handle its expected non-zero status:

```yaml
run: >-
  npm run sync:model-catalog -- --check ||
  echo "::warning title=Model catalog drift::Run npm run sync:model-catalog and commit the refreshed snapshot."
```

Remove `continue-on-error`.

- [x] **Step 4: Add release read permissions and early admission**

Set:

```yaml
permissions:
  actions: read
  contents: read
```

After Node setup and before installation, add Bash steps that:

```bash
gh release view "${GITHUB_REF_NAME}"
git fetch origin main --no-tags
git merge-base --is-ancestor "${GITHUB_SHA}" "origin/main"
gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs" \
  --method GET \
  -f head_sha="${GITHUB_SHA}" \
  -f status=completed \
  -f per_page=100
```

Each step must use `set -euo pipefail`, give a specific error, and expose
`GH_TOKEN: ${{ github.token }}` only where the GitHub CLI requires it. The CI
query must require at least one run whose conclusion is `success`.

- [x] **Step 5: Align preflight and install behavior**

Name the tag and audit steps, run them before install, and replace all three:

```text
npm ci --legacy-peer-deps
```

with:

```text
npm ci
```

- [x] **Step 6: Prevent publication overwrites**

Use the pinned v3 release action and add:

```yaml
overwrite_files: false
```

Keep all existing publication inputs and the final existing-release check as a
time-of-check/time-of-use defense.

- [x] **Step 7: Run workflow tests and verify GREEN**

Run:

```bash
rtk npm run test:quiet -- scripts/__tests__/release-workflow.spec.ts
rtk npm run test:quiet -- scripts/__tests__/validate-release-assets.spec.ts scripts/__tests__/merge-update-manifests.spec.ts scripts/__tests__/validate-release-tag.spec.ts
```

Expected: all workflow, matrix, manifest, checksum, and tag tests pass.

---

### Task 5: Update the deploy runbook

**Files:**

- Modify: `docs/packaging-native-modules.md`

**Interfaces:**

- Consumes: hardened workflow admission behavior.
- Produces: an accurate operator checklist for the first and later releases.

- [x] **Step 1: Correct the immutable-release claim**

Document that the repository setting must be enabled and verified by an
administrator before tagging. Explain that the endpoint requires
Administration read and that the workflow deliberately does not carry that
elevated credential. Do not claim current enablement.

- [x] **Step 2: Document provenance admission**

Add exact pre-tag requirements:

```text
- target commit is on origin/main;
- the exact SHA has a successful full CI workflow;
- package version and stable tag match;
- no GitHub Release already exists for the tag.
```

- [x] **Step 3: Document action pin maintenance**

State that action upgrades require reviewing the upstream release and replacing
the full SHA plus its readable version comment in both workflow files.

---

### Task 6: Complete verification and close working documents

**Files:**

- Rename:
  `docs/plans/2026-07-25-ci-release-hardening_plan.md` to
  `docs/plans/2026-07-25-ci-release-hardening_plan_completed.md`
- Rename:
  `docs/plans/2026-07-25-ci-release-hardening_spec_planned.md` to
  `docs/plans/2026-07-25-ci-release-hardening_spec_completed.md`

- [x] **Step 1: Run targeted and security gates**

```bash
rtk npm run audit:production
rtk npm run audit:build
rtk npm run test:quiet -- src/main/diagnostics/heap-snapshot.spec.ts
rtk npm run test:slow -- src/main/diagnostics/heap-snapshot.e2e.spec.ts
rtk npm run test:quiet -- scripts/__tests__/release-workflow.spec.ts scripts/__tests__/validate-release-assets.spec.ts scripts/__tests__/merge-update-manifests.spec.ts scripts/__tests__/validate-release-tag.spec.ts
```

- [x] **Step 2: Run canonical and additional project gates**

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run lint:fast
rtk npm run check:ts-max-loc
rtk npm run verify:architecture
rtk npm run test:quiet
rtk npm run test:slow
```

- [x] **Step 3: Inspect workflows and diff**

```bash
rtk git diff --check
rtk git diff -- .github/workflows package.json package-lock.json scripts/__tests__ src/main/diagnostics docs/packaging-native-modules.md
rtk git status --short
```

Confirm no unrelated dirty path was modified and both active documents remain
untracked.

- [x] **Step 4: Record as-built evidence**

Update this plan and the specification with exact dependency versions, red/green
test evidence, verification command results, and a pointer to the deferred
immutable-release live check. Do not add content after the plan is renamed
`_completed`.

- [x] **Step 5: Close the documents**

Update the specification link to the completed plan, rename both documents with
`_completed`, and verify their final Git status. Do not stage or commit them.

---

## As-Built Evidence

Completed 2026-07-25.

- Reproduced the original shard-4 failure before editing: 1 of 4,108 tests
  failed when the heap snapshot exceeded Node's maximum string length.
- Reproduced the original production audit failure: five high and one low
  finding.
- The final lockfile resolves `electron-updater@6.8.9`,
  `builder-util-runtime@9.7.0`, `dompurify@3.4.12`, `fast-uri@3.1.4`,
  `js-yaml@4.3.0`, `brace-expansion@5.0.8`, Discord's
  `undici@6.28.0`, `tar@7.5.22`, `whatsapp-web.js@1.34.7`,
  `electron-builder@26.15.7`, `app-builder-lib@26.15.7`, and the private
  `archiver@7.0.1` compatibility workspace backed by
  `archiver-modern@8.0.0`.
- `npm run audit:production` reports zero vulnerabilities.
- `npm run audit:build` exits `0`, blocks every critical or newly introduced
  high finding across the full lockfile, limits the reviewed high baseline to
  six explicit development/build advisories, and independently enforces the
  patched `app-builder-lib >=26.15.0` minimum that prevents vulnerable
  AppImage generation.
- `npm ls --omit=dev --all` exits `0`; compatibility tests validate every
  installed Minimatch and create a real ZIP through the WhatsApp Archiver API.
- Strict `npm ci` exits `0`, rebuilds `better-sqlite3` for Electron ABI 143,
  and installs the final workspace graph without `--legacy-peer-deps`.
- The final full unit tier passes: 1,577 files and 15,639 tests, with one
  intentional skip.
- The slow tier passes: 5 files and 5 tests, including the isolated real
  22 MB heap snapshot with a bounded prefix read.
- Both TypeScript checks, Angular lint, fast lint (568 warnings, 0 errors), the
  LOC ratchet, architecture verification, and `git diff --check` pass.
- The complete build passes. Its existing Angular initial-bundle warning
  remains at 721.02 kB against the 500 kB warning budget.
- Unsigned arm64 macOS packaging passes on Electron Builder 26.15.7, the
  packaged ASAR contains both compatibility archive packages, and the packaged
  startup smoke passes.
- The independent code review's release blockers were corrected: no
  administration-only API is queried with `GITHUB_TOKEN`, no incompatible
  cross-major override remains, and the Linux AppImage builder is on the
  patched 26.15 line. No commit, push, tag, release, branch, or repository
  setting was mutated.

Deferred live validation:
[2026-07-25-ci-release-hardening_livetest.md](./2026-07-25-ci-release-hardening_livetest.md)
records the external immutable-release enablement and administrator API check.
