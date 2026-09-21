# Browser Bitwarden Stale-Session Recovery — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-15-browser-bw-stale-session-recovery-followup_plan_completed.md](2026-09-15-browser-bw-stale-session-recovery-followup_plan_completed.md)

**Prerequisites:** rebuild and restart Harness from the task checkout so the running main process
contains the new Bitwarden runner and stale-session recovery code. Use the Browser Gateway on
`windows-pc`, node `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`. Do not print the Bitwarden master
password, `BW_SESSION`, item output, or command stderr. Do not submit the Jaggaer login form or take
any other portal action.

## Status — 2026-09-15

Open: 0 · Closed: 2 · Failed: 0

These checks are deferred because the rebuilt main process must replace the Harness process hosting
the current task. The code, focused tests, and build gates that do not require that restart are
recorded in the linked plan.

## Outstanding checks

### 1. Recover automatically during a secure Windows credential fill

**Result:** PASS — 2026-09-15 22:54 BST. See the redacted evidence run below.

1. Rebuild and restart Harness from the task checkout.
2. Through the Browser Gateway, preflight `windows-pc` and use `browser.find_or_open` to reacquire
   the shared `https://education.app.jaggaer.com` login target. Do not assume retained profile or
   target identifiers.
3. Deliberately invalidate the gateway's in-memory Bitwarden session from a shell:
   - run `bw lock` once;
   - run `bw unlock --passwordenv BW_PASSWORD --raw --nointeraction`, supplying the authorised
     password through the environment and discarding stdout and stderr;
   - report only the exit code. Do not run `bw lock` as cleanup.
4. Call `browser.fill_credential` on that shared target with vault item
   `a6a4c8b5-4ed1-4162-91d0-b4b1011d2368`, mapping `username` to `#username` and `password` to
   `#password`.
5. Confirm the operation succeeds and reports two filled fields. Inspect only non-secret outcome
   metadata; do not read field values, take a screenshot containing them, or submit the form.

**Expected:** the first locked Bitwarden response causes one automatic re-unlock and one retry; the
fill succeeds without `bw_command_failed` or `vault_relock_failed:*`, and no secret appears in logs
or tool output.

**Why deferred:** the running Harness main process predates the rebuilt code, and restarting it would
terminate the active implementation session.

**Evidence to record:** restart/build identity, reacquired worker/profile/target identifiers,
redacted `browser.fill_credential` decision/outcome/filled-count, and any safe reason code.

---

### 2. Confirm CLI enrol uses the recovered shared vault

**Result:** PASS — 2026-09-15 22:51 BST. See the redacted evidence run below.

1. With the rebuilt Harness still running after Check 1, deliberately invalidate the gateway's
   now-current session again:
   - run `bw lock` once;
   - run `bw unlock --passwordenv BW_PASSWORD --raw --nointeraction`, supplying the authorised
     password through the environment and discarding stdout and stderr;
   - report only the exit code. Do not run `bw lock` as cleanup.
2. Immediately run:

   ```bash
   $AIO_MCP browser-credentials enrol \
     --item a6a4c8b5-4ed1-4162-91d0-b4b1011d2368 \
     --origin https://education.app.jaggaer.com
   ```

3. Confirm exit code 0 and the command's non-secret success metadata without printing any
   Bitwarden item data or secret-bearing output. Do not use `browser-credentials list` as evidence
   of the vault origin binding: it lists credential authorizations, not vault bindings.

**Expected:** enrol itself encounters the externally rotated session, automatically re-unlocks,
and no longer fails with `bw list failed (exit 1)`, `bw_command_failed`, or
`vault_relock_failed:*`.

**Why deferred:** this command reaches the currently running Harness RPC server, so it cannot verify
the source fix until that server has been rebuilt and restarted.

**Evidence to record:** the second rotation's exit code plus the enrol command's exit code and
redacted success metadata only.

## Evidence run — 2026-09-15 21:07 BST (post-restart, partial)

- Browser Gateway health returned `ready`. The `windows-pc` remote extension was enabled, running,
  non-silent, registered, and reporting recent contact on extension version `0.2.33`.
- Target preflight found no shared Jaggaer tab among the 12 reported Windows tabs.
- Three health-timed `browser.find_or_open` attempts returned
  `browser_extension_command_not_delivered`. Each response explicitly confirmed that `open_tab`
  did not run. The last failure occurred despite extension contact one second earlier.
- A refreshed target listing hit the same delivery failure and returned only the 12 cached targets,
  all marked stale. Because health reported the extension as non-silent, the narrowly scoped
  `browser.recover_extension` precondition was not met and recovery was not invoked.
- The current agent shell retained neither `$AIO_MCP` nor the required privileged RPC environment
  after the Harness restart. The credential source remained readable, but the CLI reference
  forbids attempting privileged writes when those injected values are absent.
- No Bitwarden lock/unlock command was run, no credential was filled, and no portal action was
  taken. Both checks remain open pending a freshly shared Jaggaer tab and a fresh post-restart
  Harness agent environment for the CLI check.

## Evidence run — 2026-09-15 22:51 BST (Check 2 passed; Check 1 open)

- Browser Gateway health returned `ready`. The `windows-pc` extension was enabled, running,
  non-silent, registered, command-deliverable, and reporting sub-second contact on extension
  version `0.2.33`.
- A refreshed Windows target inventory succeeded and confirmed the existing Jaggaer target was an
  authenticated tender page, not the login page required for Check 1. No portal mutation was made.
- The post-restart agent environment contained the required privileged AIO MCP variables. Their
  values were neither printed nor persisted.
- For Check 2, the external `bw lock` and non-interactive `bw unlock --passwordenv ... --raw`
  commands both exited 0 with stdout and stderr discarded, deliberately making the gateway's
  in-memory session stale.
- `$AIO_MCP browser-credentials enrol` then exited 0. Redacted structural inspection confirmed a
  JSON object with a non-empty vault reference, a non-empty username field, and the exact requested
  origin. `movedIntoFolder` was false because enrolment did not need to move the already-enrolled
  item. No username, credential body, session token, master password, or command stderr was shown.
- Check 2 is closed. Check 1 remains open because the only current same-origin shared target is the
  authenticated tender page and therefore does not expose `#username` and `#password` for the
  required secure-fill verification.

## Evidence run — 2026-09-15 22:54 BST (all checks passed)

- James confirmed Harness had been restarted. The task checkout was at `b8bfc7c70a7b` when the
  final live check ran; Browser Gateway health was `ready`, and the current runtime exposed the
  rebuilt credential-fill contract. The successful stale-session recovery below is behavioural
  proof that the fixed recovery path was active.
- To preserve the authenticated Jaggaer tender tab, Browser Gateway opened a separate disposable
  Windows tab and navigated only that target to the public login page. The login page resolved to
  `https://education.app.jaggaer.com/web/login.html`; redacted inspection confirmed `#username`
  and `#password` exist without reading either value.
- The reacquired disposable login target used node
  `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`, profile
  `existing-tab:n.bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be:771560047:771560331`, and target
  `existing-tab:n.bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be:771560047:771560331:target`.
- Immediately before secure fill, a second external `bw lock` and non-interactive
  `bw unlock --passwordenv ... --raw` both exited 0 with stdout and stderr discarded, making the
  gateway session stale again after Check 2 had recovered it.
- `browser.fill_credential` returned `decision: allowed`, `outcome: succeeded`, and
  `filledCount: 2`. It returned no failure reason. No field value was queried, no screenshot was
  taken, and the login form was not submitted.
- Both stale-session entry points therefore recovered in the restarted app: secure Windows fill
  and `$AIO_MCP browser-credentials enrol`. No `bw_command_failed` or
  `vault_relock_failed:*` surfaced.
