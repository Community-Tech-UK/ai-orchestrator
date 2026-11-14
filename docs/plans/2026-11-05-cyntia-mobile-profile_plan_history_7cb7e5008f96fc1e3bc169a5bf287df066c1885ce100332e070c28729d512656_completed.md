## Snapshot of 2026-11-05-cyntia-mobile-profile_history.md

# History: Cyntia's phone profile

Round evidence for [the plan](2026-11-05-cyntia-mobile-profile_plan.md). Active; do not commit.

## Round 2 (resume after the usage wait, 11 November 2026)

Start state: steps 2 to 4 were already on the branch base (profiles, member routes, per-person live data). James's answer
for decision 1: she uses his accounts. Built this round: steps 5 and 6. Steps 1 and 7 need `ctadmin`, a real phone and
Tailscale admin, so they are in [the livetest](2026-11-05-cyntia-mobile-profile_plan_livetest.md).

### Built

- Member session settings (`MobileMemberProfile.session`: computer, folder, accounts), validated in the registry.
- `POST /api/instances` for a member (`mobile-gateway-member-session.ts`): server-set folder, `forceNodeId`, account
  fence, `yoloMode`, stamp; Claude/Codex only; refuses with a plain reason when not set up. Attachments validated for
  owner and member.
- Restore (`history-restore-member.ts`), crash revival (`continuity-revival.ts`), history entry stamp, saved-state stamp.
- System prompt, per-message retrieval, memory ingestion and orchestration commands blocked for member sessions.
- `WorkerNodeRegistry.setReservedNodeIds` / `getSharedNodes`; used by `selectNode`, the Browser Gateway's browser
  computer choice, auxiliary-model discovery and voice transcription.
- Settings > Mobile > People (+ four IPC channels, optional person on `ISSUE_PAIRING`), session-row name chip,
  `MobileSnapshot.isOwner`, phone-app member view (menu, new session).
- `docs/decisions/rejected/ui-and-product-scope.md` records the narrow exception. `scripts/check-ts-max-loc.ts`: ceiling
  for `history-restore-coordinator.ts` 708 to 716 (+11 lines of wiring; the file was already 755).

### Read, not live-tested

- Wake: `wakeInstance` (`instance-lifecycle.ts` around 2020 to 2330) rebuilds the adapter from the session's retained
  `executionLocation` through `createRuntimeAdapter`; it has no local fallback. Node failover (`node-failover.ts`) only
  degrades or fails sessions, never re-places them.
- What a worker can ask Harness to do: `rpc-event-router.ts` emits `remote:instance-*` events carrying `{nodeId,
  instanceId}`; `remote-cli-adapter.ts` drops any event whose `matchesRemoteInstance(nodeId, instanceId)` is false
  (lines 99 to 200), so a worker cannot feed output, state, permission requests or completion into a session that runs
  elsewhere. Not covered by that check and left for livetest 2: the browser-extension RPCs (`browser.ext.*`) a worker may
  send, and the worker's own token file permissions. The reserved computer is now kept out of the Browser Gateway's
  browser-computer choice, so the owner's browser work cannot land there.

### Independent review (fresh agent, opus) and what was done

Verdict FAIL on first pass; findings and resolution:

1. Orchestration commands in a member's reply (spawn helper on another computer, `call_tool` on the owner's connectors,
   `create_automation`) would run as the owner. Fixed: `processOrchestrationOutput` ignores them for stamped sessions;
   Harness command guide left out of her prompt. Test: `instance-orchestration.member.spec.ts`, prompt spec.
2. Owner's long-term memory retrieved into every member message and her messages ingested into shared memory. Fixed:
   `buildInputContexts` returns nothing, `addToOutputBuffer` does not ingest. Tests: `instance-input-contexts.spec.ts`,
   `instance-communication.member-memory.spec.ts`.
3. Resumed session may keep an account the owner un-ticked. Not changed: the routing service deliberately never moves a
   live thread (`provider-account-routing-service.spec.ts` "a live thread never moves"). Recorded in the plan's Risks.
4. Restore and revival used the computer the session last ran on. Fixed: refuse when it is not the computer now set up
   for her, or not recorded (restore: `MEMBER_COMPUTER_CHANGED`; revival: validation error). Tests added.
5. Reserved computer still chosen for auxiliary-model and voice work. Fixed with `getSharedNodes()`. Not changed (not
   examined further): `local-ai-guard/local-ai-runtime.ts` and `orchestrator-tools-step.ts:310` read `getAllNodes()`.
6. Session start skipped the attachment checks. Fixed (`isValidMobileAttachments`, owner and member; test added).
7 to 9. People card now says her sessions run without approval prompts and why Save is disabled; the row uses
   `memberProfileIdOf`; the people store retries after a failed read. Item 10 (`isOwnerPhone(null)` is true until the
   first snapshot) left as is: the gateway refuses owner routes anyway.

The queue's independent verifier has not run yet; this review was my own pre-handover pass.

### Checks (worktree)

- `npm run checks`: typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer all
  passed (run on the Windows PC, last run after the final edit).
- `npm run generate:ipc`, `generate:aliases`, `generate:architecture`, `verify:ipc`, `check:contracts`: ran, passed.
- Targeted Vitest (quiet runner): `src/main/{instance,rlm,services/voice,browser-gateway,providers,session,ipc,app,
  remote-node,history,mobile-gateway,core}` 1005 files, 14,907 tests, all passed (after the final edit). Renderer:
  `mobile-settings-tab.component.spec.ts` (new), `mobile-people.store.spec.ts` (new), `instance-row.component.spec.ts`
  (60 tests) passed.
- Phone app (after `npm ci --ignore-scripts` in `apps/mobile`, git-ignored): `new-session`, `projects.behavior`,
  `core/owner` specs pass (47 + 15 + 2 tests); `tsc -p tsconfig.app.json --noEmit` and eslint on the changed files clean.
- Not run: the full project suite (the verifier does), any browser or phone, the dev app.

### Failures that were already there

- `apps/mobile/src/app/features/projects/project-question-status.spec.ts` (2 tests): expects "Needs your approval", the
  shared wording renders "Needs your OK". It exercises `mobile-session-row.component.ts` and the project list view model,
  which this work did not touch.

### Left for a person

Livetest checks 1 to 8: separate Mac login (needs `ctadmin`), her login cannot read James's files, two people at once, a
real end-to-end run, the desktop screens in the running app, the phone app as a member on the real iPhone, Tailscale
limits and push alerts, and OpenAI's terms.

## Post-merge repair (13 November 2026)

Two checks failed after the base branch was merged in.

- `check:ts-max-loc`: `mobile-gateway-instance-routes.ts` was 717 lines. The owner's and member's new-session config building moved to the new `mobile-gateway-create-config.ts` (the routes file is now about 685 lines). The error class was renamed `MobileMemberSessionError` to `MobileSessionRequestError`, since it now also covers the owner's "worker node not found". The account list is read only for a member (the owner path must not touch the real account store; the server specs caught this).
- `visible-error-ratchet.spec.ts`: 5 new raw `.message` sites (3 in `mobile-settings-tab.component.ts`, 2 in `mobile-gateway-ipc.service.ts`). They now use `presentError(x).rawDetail`, as `computers-list.component.ts` does. The baseline is unchanged.

Checks: `npm run checks` all 7 pass; the ratchet spec, `src/main/mobile-gateway`, `src/renderer/app/features/settings` and `src/renderer/app/core` pass (212 files, 2240 tests). The full suite was not re-run here; the verifier does that.

## Verifier round 2 repairs (13 November 2026)

- Folder on restore and revival: `memberSessionPolicy` now carries the folder currently saved for the person
  (`workingDirectory`), and is spread last in native restore, restore fallback and crash revival, so an archived folder
  can no longer win. It throws if the person has no session settings (all callers already refuse that case first).
  `buildMemberCreateConfig` no longer sets the folder separately. New test in
  `history-restore-coordinator.member.spec.ts` (archived folder differs; every create call gets the saved one) and the
  revival member test now asserts `workingDirectory`.
- Deferred checks: the eight live checks are reported as deferred in the handover under the same titles as the headings
  in the livetest document (check 8 gained an Expected line).
- Checks: member restore spec, continuity-revival spec and `src/main/mobile-gateway` pass (23 files, 426 tests);
  `npm run checks` all 7 pass.
