# CI and Release Hardening Specification

Status: implemented and agent-verified; external immutable-release enablement
is deferred to the linked live test

Implementation plan:
[2026-07-25-ci-release-hardening_plan_completed.md](./2026-07-25-ci-release-hardening_plan_completed.md)

## Problem

The `main` branch CI has failed repeatedly since 2026-07-21. The latest run,
`30156551071`, has two independent hard failures:

1. `npm audit --omit=dev --audit-level=high` reports five high-severity
   production dependency findings. One affects `electron-updater` through
   `builder-util-runtime` and can leak authorization credentials across an
   updater redirect.
2. Shard 4 writes a real V8 heap snapshot after thousands of tests and then
   reads the entire file into one JavaScript string to inspect its first 32
   characters. The snapshot exceeds Node's maximum string length, so
   `fs.readFileSync(..., "utf8")` throws.

The release workflow has never run and the repository has no stable release
tags. Read-only repository checks also found:

- GitHub immutable releases are disabled, although the packaging runbook says
  published release assets are immutable.
- `main` has no branch protection.
- The release workflow does not prove that the tagged commit is on `main` or
  that the exact commit completed the full CI workflow successfully.
- The release workflow publishes Linux AppImages with
  `app-builder-lib@26.8.1`, below the 26.15.0 fix for uncontrolled library
  search paths in generated AppImages.
- The security audit runs at the end of the four-minute quality job, so a
  lockfile-only failure is discovered after all expensive quality work.
- Release dependency installation uses `--legacy-peer-deps`, while normal CI
  uses the lockfile without that compatibility mode.
- Actions are referenced by movable tags rather than full commit SHAs.
- The external model-catalog drift probe is intentionally non-blocking but
  still renders as a failed step, adding noise to failure notifications.

## Required Behaviour

1. The current production dependency graph must have no high- or
   critical-severity `npm audit` findings.
2. The normal unit shards must not write a heap snapshot whose size depends on
   the accumulated heap of thousands of preceding tests.
3. A real V8 snapshot must still be exercised in CI, in the isolated slow tier,
   and its JSON prefix must be inspected with a bounded file read.
4. Production dependency auditing must run as a fast, independent CI gate
   directly from `package-lock.json`.
5. The expensive macOS packaging smoke must not start when the security gate
   has failed.
6. External model-catalog drift must remain visible but must be reported as a
   warning rather than a failed step.
7. A release must fail before matrix builds unless:
   - its stable tag exactly matches `package.json#version`;
   - the tagged commit is an ancestor of `origin/main`;
   - the exact commit has a completed, successful `ci.yml` run;
   - no GitHub Release already exists for the tag.
8. Release dependency installation must use the same strict `npm ci` contract
   as normal CI, and the release preflight must rerun the production security
   audit before installing dependencies.
9. Every external GitHub Action reference in CI and release workflows must be
   pinned to a full commit SHA, with a readable version comment.
10. Publication must retain the existing complete-matrix, checksum,
    signing/notarization, packaged-startup, duplicate-name, and
    no-overwrite safeguards.
11. Repository immutable releases must be enabled and independently verified
    by an administrator before the first stable tag. The workflow must not
    receive an administration-capable credential solely to query that setting.
12. No repository settings, commits, tags, releases, or remote branches may be
    mutated as part of this implementation.
13. Release admission must reject critical full-tree audit findings, reject
    every high advisory not present in an explicit reviewed baseline, and
    independently prove that every locked `app-builder-lib` is at least
    26.15.0.

## Recommended Design

### Dependency repair

Refresh only the vulnerable production dependency paths. Confirm the installed
graph contains patched `electron-updater`, `builder-util-runtime`, `dompurify`,
`fast-uri`, and `js-yaml`. Update `whatsapp-web.js` within its existing range.
Its optional RemoteAuth path requires Archiver's callable CommonJS v7 entry
point, while the fixed Archiver v8 package exports classes. Supply a private
workspace compatibility package named `archiver@7.0.1` that preserves the
callable API and delegates to an aliased `archiver@8.0.0` implementation. Pin
the production `brace-expansion` v5 line to 5.0.8, and keep Discord's exact
Undici consumers on a patched 6.x release instead of the repository's existing
global v7 override. Do not force `brace-expansion` v5 into v1/v2 consumers:
their CommonJS APIs are incompatible. Add runtime smokes for a valid installed
production tree, brace patterns through every installed `minimatch` copy, and
WhatsApp's archive-call contract so remediation cannot silently break
packaging.

Expose the lockfile-only audit as `npm run audit:production`:

```text
npm audit --package-lock-only --omit=dev --audit-level=high
```

The command is suitable both before `npm ci` in CI and as a local/release gate.

Upgrade Electron Builder and `app-builder-lib` to 26.15.7. Add a fail-closed
lockfile audit wrapper that rejects every critical finding and every high
advisory outside the six reviewed development/build advisories present on
2026-07-25. Add a release-toolchain policy that rejects a missing, malformed,
or pre-26.15.0 `app-builder-lib`. This keeps new high artifact-generation
advisories hard failures without forcing known cross-major overrides into
unrelated legacy development consumers.

### Heap snapshot isolation

Keep cheap heap-summary and path-collision tests in
`heap-snapshot.spec.ts`. Move the single real `writeHeapSnapshot()` test to
`heap-snapshot.e2e.spec.ts`, which is excluded from normal shards and included
by `vitest.slow.config.ts`.

The slow test will open the generated file, read at most 32 bytes into a fixed
buffer, close the descriptor, and assert that the prefix begins with `{`. This
continues to exercise the real production wrapper without allocating a string
proportional to the snapshot size. Running in the slow-tier process also makes
the generated file depend on a small, isolated heap rather than the accumulated
unit-shard heap.

### CI gate structure

Add a `Production Dependency Audit` job that checks out the repository, sets up
the pinned Node version, and runs `npm run audit:production` plus
`npm run audit:build` without installing dependencies. Remove the late audit
step from the quality job.

Make macOS packaging smoke depend on quality, all unit shards, and the security
job. Keep unit and slow tests independently useful so a security advisory does
not hide unrelated test diagnostics.

Turn model-catalog drift into an explicit GitHub warning while keeping the step
successful.

### Release admission and publication

Before installation or matrix build, the release preflight will:

1. reject an existing release for the tag;
2. fetch `origin/main` and prove the tag commit is an ancestor;
3. query `ci.yml` runs for the exact SHA and require a completed successful
   `push` run on `main`;
4. validate the stable tag against `package.json`; and
5. run the lockfile-only production audit; and
6. run the critical full-tree audit plus the patched AppImage-builder policy.

The workflow will request only `actions: read` and `contents: read` globally;
only the publish job retains `contents: write`. Publication continues through
the release action's draft-first asset upload path and sets
`overwrite_files: false`, so even a race with the early existing-release check
cannot replace an asset.

All external actions will use audited full SHAs. Strict `npm ci` will be used in
preflight, build, and publish jobs.

GitHub's immutable-release status endpoint requires repository Administration
read permission, which the workflow's standard `GITHUB_TOKEN` cannot request.
Giving the release workflow an elevated repository-administration credential
only for this read would expand the blast radius of every release run. The
runbook therefore treats immutable releases as an administrator-verified
external prerequisite and records the still-disabled live setting as a
deferred live check.

## Alternatives Rejected

1. Only change `readFileSync` to a bounded read. This clears the exception but
   leaves a multi-hundred-megabyte, accumulated-heap snapshot in the normal unit
   shard.
2. Disable or soften the security audit. The current findings affect production
   code, including the auto-updater's handling of credentials, so the correct
   response is to patch the graph and keep the gate hard.
3. Depend only on branch protection. Repository policy is currently absent and
   external to this code change. The release workflow must still verify its own
   provenance at runtime.
4. Build a full artifact-promotion and attestation platform now. Reusable
   workflows, environment approvals, SBOMs, and provenance attestations are
   worthwhile follow-ups, but they require repository policy and operational
   decisions beyond the failing CI/deploy path.
5. Give the release workflow an Administration-read PAT solely to check the
   immutable-release setting. The standard token cannot access that API, and
   introducing a more privileged long-lived credential would weaken the
   workflow's least-privilege boundary. The live administrator check is kept
   explicit instead.

## Verification

- Reproduce shard 4 before the change with:
  `AIO_TEST_NO_CACHE=1 AIO_TEST_SUMMARY=0 npm run test:quiet -- --shard=4/4`.
- Reproduce the audit gate before the change with:
  `npm run audit:production` after the script is introduced but before the
  lockfile refresh.
- Run the focused unit and slow heap-snapshot specs.
- Run the release-workflow specification and release asset/tag/manifest specs.
- Run `npm ci` to prove the strict lockfile install contract.
- Run the canonical project gates:
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - `npm run check:ts-max-loc`
  - `npm run test:quiet`
- Run `npm run test:slow`, `npm run lint:fast`,
  `npm run verify:architecture`, `npm run audit:production`, and
  `npm run audit:build`.
- Parse both workflow YAML files and inspect the final diff and Git status.

## As-Built Implementation

- The production lockfile audit reports zero vulnerabilities. Patched paths
  include `electron-updater@6.8.9`, `builder-util-runtime@9.7.0`,
  `dompurify@3.4.12`, `fast-uri@3.1.4`, `js-yaml@4.3.0`, and
  `brace-expansion@5.0.8`; the archive/extraction path also pins
  `tar@7.5.22`.
- Electron Builder and `app-builder-lib` resolve to 26.15.7. The fail-closed
  build audit rejects critical findings and high advisories outside its six-ID
  reviewed baseline, then separately enforces `app-builder-lib >=26.15.0` from
  `package-lock.json`.
- Discord's exact Undici consumers resolve to compatible
  `undici@6.28.0`. `whatsapp-web.js@1.34.7` resolves its optional
  `archiver@7.0.1` API to the private `packages/archiver-compat` workspace,
  which delegates to `archiver@8.0.0` as `archiver-modern`.
- Dependency regression coverage proves the installed production tree is
  valid, exercises brace patterns through every installed Minimatch copy, and
  creates a real ZIP through WhatsApp's callable Archiver contract.
- The real V8 snapshot test now runs only in the slow tier and reads a bounded
  32-byte prefix.
- CI now has an independent production/build audit gate, macOS packaging waits
  for that gate, action refs are commit-pinned with version comments, and
  model catalog drift emits a warning without painting the step red.
- Stable release preflight now requires an unused tag, ancestry on `main`, an
  exact-SHA successful `push` CI run on `main`, a matching stable version, and
  a clean production audit and a reviewed build-advisory baseline before
  strict installation. Publication refuses existing releases, duplicate asset
  names, missing assets, and overwrites.
- The impossible immutable-release API check was removed after independent
  review established that it requires Administration read unavailable to
  `GITHUB_TOKEN`. The runbook and live-test document now keep this
  administrator prerequisite explicit without placing an elevated credential
  in the release workflow.

## Operational Follow-up

The GitHub immutable-releases setting remains disabled. Enabling and verifying
that repository setting is an external administrative action recorded in
[2026-07-25-ci-release-hardening_livetest.md](./2026-07-25-ci-release-hardening_livetest.md).
Branch protection with required CI checks is also recommended as a
repository-level defense; release admission does not replace review-time branch
protection.
