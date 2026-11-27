# Capability repair cd33bb0f-a777-4078-9e83-728e0fd3ee60

## Status

On main: yes (this landing commit)
Built, not yet probed. The `account_trial` tool (reserve, start_session, release, status) is implemented in the queue
worktree with unit and wiring specs; typecheck, spec typecheck, lint, LOC, UI hints, build:main and build:renderer pass.
Verifier round 1 found the one-time approval path failed ("unknown orchestrator-tools instance": the restarted session
replays the approved call while still `respawning`); fixed by a resume mark (deferred-permission-resume-registry.ts)
the RPC gate honours. Round 2 found simultaneous start_session calls could pass the 16-session cap; fixed by counting
in-flight starts (`starting` map) before the first await, with specs. Next: independent verifier, then the runtime probe in an ordinary (not Auto-approve) session on
the PC or test Mac per the livetest document, reported via `plan_queue_report_capability_probe`.
**James, 27 Nov 2026 (option B):** build the control for test and trial work; it creates or signs in no account. The MiMo
"subs" account is not in Harness, so that arm stays blocked until it exists.
Decisions: one tool with an action field; only `manual-only` can be written; legacy profiles are allowed (ClaudeSUAS and
CodexSUAS are legacy); a lease ends on release, owner exit, expiry or app start. Known gap: started sessions have no
parent, so they are not counted by the spawn-depth limit (bounded by one lease per account, 16 sessions each).
Round evidence: [history](capability-cd33bb0f-a777-4078-9e83-728e0fd3ee60_plan_history_99da9d1fb3cd3d57e4a9c21c9238f3fbca54e8af5624e8fd9f03a95d02e9c4e0_completed.md). Live checks:
[livetest](capability-cd33bb0f-a777-4078-9e83-728e0fd3ee60_livetest.md).

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "trial-account-reservation",
  "check": "Reserve ClaudeSUAS, CodexSUAS and the subs MiMo account (manual-only) and run isolated per-arm chat sessions for the eight-task trial",
  "requiredAction": "A supported agent-usable way to set and restore account automation policies and to start new chat sessions on a named account",
  "platform": "any",
  "provider": "harness",
  "classification": "capability",
  "attempts": [
    {
      "operation": "get_setting providerAccountProfiles",
      "observedAt": 1795773300000,
      "result": "writable:false, policyTier read-only; ClaudeSUAS disabled, CodexSUAS allow-routed; no subs MiMo profile listed."
    },
    {
      "operation": "Reviewed orchestrator tools for session creation on a chosen account",
      "observedAt": 1795773300000,
      "result": "No tool starts a chat session per account; automations are not equivalent to the ordinary chat sessions the plan requires."
    }
  ],
  "alternative": "James changes the three policies by hand in account settings and starts the arm sessions himself.",
  "expectedResult": "Policies saved, changed to manual-only, restored after the trial; each arm runs in a fresh session on its own account.",
  "implementation": "Add a test-owned, logged operation that saves, sets and restores automationPolicy for named profiles, plus a session-start control that takes a profile id; cover restoration on cancel and failure."
}
</capability_evidence>

## Refined design (written before code, 27 Nov 2026)

**Reproduction (this session, queue worker, existing tools):** `get_setting providerAccountProfiles` returns
`writable:false, policyTier:"read-only"` and lists ClaudeSUAS (claude `legacy`, `disabled`) and CodexSUAS (codex
`legacy`, `allow-routed`); no MiMo "subs" profile. The only writer is `ProviderAccountStore.updateProfile`
(`src/main/providers/account-pool/provider-account-store.ts`), reached from Settings IPC only. The orchestrator tool
list has no per-account session start. Call path for a named-account chat: `createInstance({accountProfileId})` ->
`instance-spawn-preflight-chain.ts` -> `attachAccountRoute(... 'interactive', explicitProfileId)` ->
`provider-account-routing-service.ts:363`, which refuses an explicit profile whose policy is `disabled` (that is why
ClaudeSUAS must be reserved first) but accepts `manual-only` for an interactive origin. Both legacy profiles share
the id `legacy`, so every operation keys on provider + profile id.

**Interface:** one MCP tool, `account_trial`, with `action`:
- `reserve {profiles:[{provider,profileId}] (1-6), ttlMinutes? (default 240, max 720)}`: saves each profile's current
  `automationPolicy`, sets it to `manual-only` (the only value the tool can write), returns a lease id and receipt.
- `start_session {leaseId, provider, profileId, prompt, model?, workingDirectory?, name?}`: starts an ordinary
  (non-yolo, unparented, interactive-origin) chat session on that profile; refused unless the profile is in the
  caller's live lease.
- `release {leaseId}`: restores policies, terminates still-live sessions that lease started, returns a receipt.
- `status {}`: the caller's leases and what each would restore.

**Files:** new `src/main/providers/account-pool/account-trial-lease-service.ts` (lease logic, persistence to
`<userData>/account-trial-leases.json`, write-ahead before changing a policy, audit log lines, sweep);
new `src/main/mcp/orchestrator-account-trial-tools.ts` (schema, tool definition, forwarder); wiring in
`orchestrator-tools.ts`, `orchestrator-tools-rpc-server.ts` (context, same-name dispatch, toolset: in full, not in
leaf, so a session at the spawn-depth ceiling cannot start sessions), `orchestrator-tools-mcp-forwarder.ts`,
`app/orchestrator-tools-step.ts` (real store, `createInstanceWithMessage`, startup recovery, 30 s sweep); spec files
beside each; one row in `docs/plans/livetest-capability-repair-runbook.md`.

**Restrictions kept:** profile must exist (`profile-missing`); a profile sits in one lease at a time; only the lease's
owning session may start, release or read it; `enabled` and every other profile field is untouched; no account is
created or signed in; the tool cannot write `allow-routed` or `disabled`.
**Restoration:** explicit release; owner session gone or terminated; lease expiry; app start (all leftover leases).
A profile is restored only if its policy still equals what the lease set; if someone changed it by hand meanwhile it is
left alone and the receipt says so. A failed reserve rolls back the profiles already changed. A failed
`start_session` leaves the lease intact for retry; the lease still ends by release, owner exit or expiry.

**Acceptance checks:** unit specs for the service (reserve/restore, rollback, overlap, legacy same-id across providers,
stale hand edit, missing profile, owner gone, expiry, startup recovery, persistence round trip, session cap, foreign
owner refused, start refused outside lease, release terminates sessions, start failure keeps lease) and the tool layer
(schema rejects bad actions/extra keys/policy values, forwarder name list, deferral/stable tool lists); typecheck,
lint, build:main, build:renderer; then a runtime probe on a remote dev-app copy (see the livetest doc).

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Reserve ClaudeSUAS, CodexSUAS and the subs MiMo account (manual-only) and run isolated per-arm chat sessions for the eight-task trial",
  "expectedResult": "Policies saved, changed to manual-only, restored after the trial; each arm runs in a fresh session on its own account."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.
