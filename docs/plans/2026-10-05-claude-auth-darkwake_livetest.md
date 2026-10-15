# Claude renewal after sleep — pending live verification

> Status: pending. Source checks do not establish that sign-in survives a real renewal after sleep.
> Prerequisites: normal rebuilt Harness containing this change, installed-app restart at a safe break in active sessions, macOS coordinator, both Claude account profiles signed in. The standalone monitor already loads its updated source on each launchd invocation.
> Implementation: [active plan](2026-10-05-claude-auth-darkwake_plan_completed.md).
> Remediation flow: read [campaign runbook](livetest-campaign-runbook.md) before executing. Record per-check evidence here. Any newly reproduced defect needs a new entry in [remediation register](livetest-remediation-register.md) and its implementation-status plan. Reopen a completed plan before changing it; never append to a `_completed` document.

## 1. Installed Harness rollout

- [ ] Use the normal packaging/install workflow after unrelated ongoing changes have their own verification. Preserve active sessions; restart only at a safe break.
- [ ] Confirm the installed main-process bundle contains the new readiness guard and 120-second renewal deadline. Record build identity and source evidence without copying credentials or private doctor output.
- [ ] With currently valid credentials, run the ordinary quota refresh for both accounts. Confirm fresh usage timestamps and no sign-in warning; distinguish exhausted quota from missing authentication.

Expected: the installed app executes the guard, and healthy reads continue to work. A compiled source smoke alone is insufficient installed-app evidence.

Why pending: replacing or restarting the current installed app would interrupt active sessions, and the shared checkout also contains independently changing work. This is a rollout prerequisite, not manual work for James to perform.

## 2. Natural maintenance wake with expired access credentials

- [ ] Observe a naturally occurring macOS maintenance wake after access-token expiry. Do not edit, clear, restore or deliberately expire real credentials; do not force sleep on the active computer.
- [ ] Correlate power-state timestamps with the ordinary pollers' renewal readiness messages. Where a poll occurs with CPU/Network but no Graphics, it must defer doctor. No new native doctor renewal should be attributable to that protected invocation.
- [ ] Record only timestamps, safe diagnostic reasons and credential-presence booleans. Never retain access tokens, refresh tokens, credential JSON or raw private subprocess output.
- [ ] If no poll occurs in the relevant maintenance wake, leave this check pending: absence of a failure does not prove the guard executed.

Expected: the usage poller preserves its expired/transient result and starts no doctor while the readiness gate rejects the environment. Existing native Claude sessions remain outside this guard; attribute any separate renewal before drawing a conclusion.

Why pending: this requires a real wake and expiry cycle in the rebuilt installed app. Safe deterministic tests already cover rejection, unknown state, interrupted DNS and dispatch-time power recheck.

## 3. Full wake and subsequent renewal

- [ ] After the observed deferral, allow the normal next poll while fully awake and the network is available. Avoid a manual doctor invocation that would confound attribution.
- [ ] Confirm the protected poll starts renewal, returns successfully and rereads current credentials. Record only the safe result and expiry time.
- [ ] Confirm both accounts return live usage without signing back in. Repeat through a later naturally occurring cycle before describing this as a durable resolution.

Expected: deferred renewal resumes automatically when ready, both accounts stay signed in, and there is no recurring lost-auth warning.

Why pending: both accounts were restored manually today and their current tokens are healthy. Current successful usage reads cannot prove expired-token renewal or survival through sleep.

## Limits and failure handling

The graphical-wake check does not prove DataProtection Keychain is unlocked. Network readiness can change after dispatch. Claude's own running sessions may renew independently. If sign-in is lost again, capture safe power/network/doctor timing before proposing a further change; the final native credential-clearing operation has not been identified.

Do not rename this document `_livetest_completed.md` until every check passes with current evidence. No commits, pushes, live credential manipulation or active-session termination are authorised by this document.
