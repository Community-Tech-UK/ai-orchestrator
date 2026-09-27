# GitHub Actions Remediation Implementation Plan

> **2026-09-23 final as-built:** Tasks 1–4 are implemented and their agent-runnable checks pass.
> Production deploy run `35842040642` passed. The installed deployment wrapper is byte-identical
> to `deploy/deploy-mytrademail`; all four GitHub production secret names exist; all four configured
> values are represented in the production Bitwarden item. The protected FCM file, dedicated
> Firebase account and SBE project match. Each deployed DSN maps to its own Community Tech Sentry
> project, and the payment, provisioning and regression alert rules are enabled. The historical
> blocker notes below describe their dated snapshots. Synthetic event delivery, alert
> acknowledgement and inherited Firebase IAM scope are tracked in
> [the live-test document](2026-08-03-github-actions-remediation_livetest.md). Final repository
> gates passed (2,218 files / 26,397 tests in the full suite), and a fresh independent
> `task-completion-gate` review returned `VERDICT: PASS` with no unresolved findings.
> The external checks in the live-test document are pending and are not claimed as verified.

> **2026-09-23 read-only re-verification:** All agent-runnable code in this plan is complete.
> `npm run check:provider-parity` passes with all eight current providers, and
> `npm run test:quiet -- src/main/orchestration/loop-control.spec.ts` passes 19 tests.
> The four previously missing `Community-Tech-UK/mytrademail` production secret
> **names** now exist in GitHub. The three Sentry names were created at 07:56 UTC
> today; the FCM path name was created on 2026-09-09. Deploy workflow run
> `35842040642` (2026-09-23) passed its build check and production deployment,
> including the deployment and post-deploy validation steps. This supersedes
> the old failed run `30717081873`; rerunning that old SHA now could roll back
> production. Secret values, Bitwarden storage, distinct Sentry project ownership,
> least-privilege Firebase key scope, and byte equality of the installed server
> wrapper were **not** verified by this read-only check. Keep this plan active
> pending final evidence/lifecycle review; the older status notes below are
> historical snapshots, not the current blocker state.

> **Status (2026-08-26 re-verification):** Tasks 1 and 2 are implemented, committed on `main`
> (`13787e42`), and still wired and green today. Task 3 remains **genuinely blocked on James** —
> but note that the 2026-08-19 evidence recorded against it was wrong (it queried the wrong
> repository); see the corrected checks in the Task 3 section. The accurate position is that
> `mytrademail`'s `production` environment exists with 27 secrets, and the four this task must
> create (`SENTRY_DSN`, `MTM_SENTRY_DSN`, `SBE_SENTRY_DSN`, `FCM_SERVICE_ACCOUNT_KEY_PATH`) are
> the ones absent from it. No `v*` tag exists, so `release.yml` has still never run. This is not
> a livetest-deferrable check — there is no code to defer verification of, Task 3 is 100%
> external account/ops work — so the plan stays **active**, not `_completed`, until Task 3 lands
> or James descopes it.
>
> **Re-verified 2026-09-20** during the outstanding-plans sweep. Position unchanged and correct:
> Tasks 1, 2 and 4 are done (`scripts/check-provider-parity.js:18` points at
> `settings-primitives.types.ts`; `LOOP_CONTROL_STALE_GRACE_MS` is in place at
> `src/main/orchestration/loop-control.ts:24`), and Task 3 is still 100% external account work
> that no agent can perform — creating three Sentry projects and a least-privilege Firebase
> service-account key requires account authority James holds and an agent does not. **This plan
> stays active on purpose.** It is the only plan in this batch that could not be closed, and it is
> blocked on you, not on engineering. Two ways to clear it: provision the four secrets, or descope
> Task 3 if the `mytrademail` deploy is deferred — either unblocks the rename.
>
> Separately, CI on `ai-orchestrator`'s `main` was red on 2026-08-25 and 2026-08-26 for a reason
> outside this plan's scope: two Copilot adapter specs timing out at vitest's 5000ms default
> because `CopilotCliAdapter`'s constructor performed a blocking `gh copilot --help` probe. That
> is a long-standing latent flake (the probe has been in the constructor since 2026-04-23), not a
> regression from this plan, and it is fixed separately.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the failing `ai-orchestrator` CI gates and the `mytrademail` production deploy using the smallest changes supported by the run evidence.

**Architecture:** Keep provider parity tied to the canonical primitive type source. Make loop-control pruning distinguish fresh in-flight directories from stale crash leftovers, leaving terminal cleanup unchanged. Keep `mytrademail` fail-closed until its missing Sentry and Firebase credentials are created under the correct accounts; then wire them through GitHub and install the reviewed wrapper.

**Tech Stack:** Node.js 24, TypeScript, Vitest, GitHub Actions, GitHub CLI, Bash/SSH

## Global Constraints

- Preserve every unrelated tracked and untracked working-tree change.
- Do not expose credential values in output, files, command arguments, or chat.
- Do not edit server-side deployment scripts.
- Do not change `central-auth`; its reruns already passed.
- Do not commit or push without James's explicit authorization.

---

### Task 1: Repair provider-parity source discovery

**Files:**
- Modify: `scripts/check-provider-parity.js`
- Canonical source: `src/shared/types/settings-primitives.types.ts`

**Interfaces:**
- Consumes: the `export type CanonicalCliType = ...;` declaration.
- Produces: the existing `npm run check:provider-parity` exit-code contract and provider checklist validation.

- [x] **Step 1: Confirm the red gate**

Run: `npm run check:provider-parity`

Expected: exit 1 with `Could not find CanonicalCliType in .../settings.types.ts`.

- [x] **Step 2: Point the checker at the canonical file**

Change only the path constant and its adjacent comment:

```js
const SETTINGS_PRIMITIVES_FILE = path.join(ROOT, 'src/shared/types/settings-primitives.types.ts');
const settingsPrimitivesSource = fs.readFileSync(SETTINGS_PRIMITIVES_FILE, 'utf8');
```

Use those names in the regular-expression match and failure message. Do not change provider parsing or checklist matching.

- [x] **Step 3: Confirm the green gate**

Run: `npm run check:provider-parity`

Expected: exit 0 and a provider list containing `claude`, `gemini`, `antigravity`, `codex`, `copilot`, `cursor`, and `grok`.

Re-run 2026-08-19: still exits 0, still lists all 7 providers. `scripts/check-provider-parity.js:18,25`
still points at `settings-primitives.types.ts` — unchanged since the original commit
(`git diff --stat HEAD` empty for the file).

### Task 2: Prevent fresh loop-control directories being pruned

**Files:**
- Modify: `src/main/orchestration/loop-control.spec.ts`
- Modify: `src/main/orchestration/loop-control.ts`

**Interfaces:**
- Consumes: `prepareLoopControl(workspaceCwd, loopRunId, activeLoopRunIds)` and `cleanupLoopControl(runtime)`.
- Produces: stale-directory cleanup that excludes active IDs and any directory modified within `LOOP_CONTROL_STALE_GRACE_MS`.

- [x] **Step 1: Add the deterministic failing regression**

In `loop-control.spec.ts`, create a fresh directory at `.aio-loop-control/loop-in-flight/intents`, then call:

```ts
await prepareLoopControl(workspace, 'loop-second', ['loop-second']);
expect(fs.existsSync(inFlightDir)).toBe(true);
```

This models a concurrent start whose ID is absent from the other caller's snapshot.

- [x] **Step 2: Run the regression and verify RED**

Run: `npm run test:quiet -- src/main/orchestration/loop-control.spec.ts`

Expected: the new assertion fails because `loop-in-flight` is removed.

- [x] **Step 3: Add age-aware stale classification**

Add a module constant:

```ts
const LOOP_CONTROL_STALE_GRACE_MS = 24 * 60 * 60 * 1_000;
```

In `pruneStaleLoopControlDirs`, skip active IDs first, read each remaining directory's `mtimeMs`, and remove it only when `Date.now() - mtimeMs >= LOOP_CONTROL_STALE_GRACE_MS`. Ignore vanished/unreadable entries as the current best-effort cleanup does.

- [x] **Step 4: Verify GREEN and the original slow tier**

Run:

```bash
npm run test:quiet -- src/main/orchestration/loop-control.spec.ts
npm run test:slow
npm run test:slow
npm run test:slow
```

Expected: every command exits 0; the concurrent-isolation E2E passes on each slow-tier run.

Re-run 2026-08-19 (targeted only, full slow tier not re-run per campaign rule to avoid the full
suite): `npm run test:quiet -- src/main/orchestration/loop-control.spec.ts` → 1 file, 13 tests
passed. `LOOP_CONTROL_STALE_GRACE_MS` and the age-aware skip in `pruneStaleLoopControlDirs`
(`src/main/orchestration/loop-control.ts:23,611`) unchanged since the original commit.

### Task 3: Provision required production deploy inputs

**Files:**
- No repository file changes.
- GitHub environment: `Community-Tech-UK/mytrademail` / `production`.
- Read-only value source: `/var/www/mytrademail/.env` on the production VPS.

**Interfaces:**
- Consumes: newly account-authorised DSNs for the backend, MTM, and SBE Sentry projects plus an FCM service-account key for the Firebase project referenced by `frontend/android-sbe/app/google-services.json`.
- Produces: GitHub environment secrets `SENTRY_DSN`, `MTM_SENTRY_DSN`, `SBE_SENTRY_DSN`, and `FCM_SERVICE_ACCOUNT_KEY_PATH`, plus a protected service-account file on the VPS.

- [x] **Step 1: Obtain account authority and create the four missing credentials**

Create three separate Sentry projects as required by `docs/operations/observability-and-push-alerts.md`. Create a least-privilege Firebase service-account JSON for the exact SBE Firebase project. This step was blocked at the 2026-08-26 snapshot below. On 2026-09-23 the three projects and the dedicated FCM sender account/key were verified to exist under the correct accounts; the production DSNs and key match them. Effective inherited IAM remains a live check.

**Correction and re-confirmation, 2026-08-26.** The 2026-08-19 evidence recorded here was
**wrong**. It ran `gh api repos/:owner/:repo/actions/secrets` and
`gh api repos/:owner/:repo/environments` from inside the `ai-orchestrator` checkout, so
`:owner/:repo` resolved to `Community-Tech-UK/ai-orchestrator` — not `mytrademail`. The zero
counts it reported described the wrong repository, and the conclusion drawn from them ("no
GitHub `production` environment exists, no deploy secrets exist") was false.

Today's checks name the repository explicitly (read-only; nothing created, changed or printed):

```
gh api repos/Community-Tech-UK/mytrademail/environments
  → 2 environments: dev, production   (production created 2026-01-09)

gh api repos/Community-Tech-UK/mytrademail/environments/production/secrets
  → 27 secrets, including FCM_PROJECT_ID, APNS_*, VPS_*, STRIPE_*

gh api repos/Community-Tech-UK/mytrademail/tags
  → []   (still no version tag, so release.yml has still never fired)
```

**The task is still blocked, but for the narrow, correct reason.** The `production` environment
is provisioned and heavily populated; what is missing from it is exactly the four credentials
this step exists to create:

| Required secret | Present in `production`? |
| --- | --- |
| `SENTRY_DSN` | no |
| `MTM_SENTRY_DSN` | no |
| `SBE_SENTRY_DSN` | no |
| `FCM_SERVICE_ACCOUNT_KEY_PATH` | no (`FCM_PROJECT_ID` exists; the key path does not) |

Creating three Sentry projects and a least-privilege Firebase service-account key is
account-authority work outside any agent's reach, so this step stays open until James acts. No
repository file changes, so there is nothing for the standard gates to verify.

- [x] **Step 2: Store and deploy without exposing values**

Store all four values in Bitwarden, set the four GitHub `production` environment secrets, install the FCM JSON on the VPS as a root-managed/readable-by-application secret file, and set `FCM_SERVICE_ACCOUNT_KEY_PATH` to that protected path. Never print or stage the values.

As built 2026-09-23: the three nonempty DSNs and the production FCM path are fields of the
production Bitwarden item. The FCM path field was added through `bw edit item` on stdin and
verified equal to the deployed setting without displaying it. The GitHub environment lists all
four secret names. The production file is a regular, non-symlink JSON file, `0640
root:mytrademail`, readable by the app; its account/key and project match the Firebase account
and SBE Android configuration. The production `.env` is `0600 mytrademail:mytrademail`.

- [x] **Step 3: Install the reviewed wrapper, verify names, and rerun**

Install `deploy/deploy-mytrademail` to `/usr/local/sbin/deploy-mytrademail` using `docs/operations/server-deployment.md`, confirm byte equality, list GitHub secret names only, rerun workflow run `30717081873`, watch it to completion, and inspect redacted failed logs if it does not pass.

As built 2026-09-23: SHA-256 of the local and installed wrappers matched. Production workflow
run `35842040642` passed deployment and post-deploy validation. The old failed run
`30717081873` is tied to an older SHA, so it was not rerun: doing so could roll production back.
The current passing run provides the required deploy result.

### Task 4: Full verification and handoff

**Files:**
- Update: this plan and its linked spec only after all checks pass.

- [x] **Step 1: Run required `ai-orchestrator` gates**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run test:quiet
npm run test:slow
```

The full default test selection passed in four CI-equivalent shards (1,728 files / 18,013 tests) with the workflow's 5 GiB Node heap. One unsharded local run exhausted the default 4 GiB heap; it produced no assertion failure and is not counted as passing evidence.

- [x] **Step 2: Inspect final diff and working-tree ownership**

Confirm only the intended script, loop-control production/test files, and active docs changed in this task. Preserve all pre-existing changes.

- [x] **Step 3: Obtain independent completion-gate review**

Start a fresh agent that uses `task-completion-gate` and reviews the acceptance criteria, current working-tree diff attributable to this task, test integrity, concurrency behavior, security, and deployment evidence. Resolve every actionable finding and repeat until `VERDICT: PASS`.

Result: `VERDICT: PASS` with no findings. The fresh reviewer used Node 24.15.0, performed a clean install, reproduced the complete CI quality/security/build chain, all four default-suite shards (18,013 tests), and the full slow tier.

Remote result: James authorised both local commits on `main`; `08b7e684` and remediation commit `13787e42` were pushed. GitHub Actions run `30809724132` passed every job, including the final slow tier and macOS native ABI/package/launch smoke.

- [x] **Step 4: Close documentation only when remotely complete**

Record as-built evidence, update the spec link, rename both files to `_completed.md`, and leave them uncommitted unless James explicitly authorizes a commit/push.

**Still blocked, 2026-08-19**: cannot close while Task 3 Step 1 remains unstarted (see above). Not
a livetest-deferral case — Task 3 has no implemented code to defer verification of; it is
unstarted, external, account-authority work. Left active.
