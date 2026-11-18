# Capability repair 9b9514ca-72a1-4f4e-8254-f47363876913

## Status

On main: yes (this landing commit)
Built, awaiting independent review and runtime probe (round 1). Added `hardened:true` to `spawn_child`: the app starts the child, so it sits outside the asking session's sandbox; the parent reads it (`get_children` now shows `hardened`, `get_child_output`, `read_session`) and removes it (`terminate_child`). Refused with a plain reason for a worker computer, a non-Mac host, unresolved `auto` or an untested provider. Checks and tests pass, rerun 18 Nov on the committed branch (see history). Probe attempts were parked only because the test Mac stayed busy (load 21 to 30 on 10 processors); no code change was needed, and both computers now show no Harness copies. Open: independent probe on the test Mac or PC; live check on the installed app with a Codex login, recorded in `capability-9b9514ca-72a1-4f4e-8254-f47363876913_livetest.md`. Evidence: `capability-9b9514ca-72a1-4f4e-8254-f47363876913_plan_history_cac2a5f37a4f6440bc08c08d9edc6aeaad8385d12a3c4edabe46bd2a37daacd1_completed.md`.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "hardened-codex-session-outside-fence",
  "check": "Create a fresh local Codex session with hardened mode enabled and observe the progress prompt and failed-command prompt in the installed app",
  "requiredAction": "Create a disposable hardened Codex session from the installed app (outside the signal fence) and read its chat back",
  "platform": "macos",
  "provider": "codex",
  "classification": "capability",
  "attempts": [
    {
      "operation": "Launch hardened Codex session from dev app inside a Harness session (11 Nov)",
      "observedAt": 1794834263000,
      "result": "Ended in error: sandbox-exec sandbox_apply Operation not permitted; adapter failed closed as designed."
    },
    {
      "operation": "Look for agent route: create_automation options and settings list",
      "observedAt": 1794834263000,
      "result": "Automation tool has no hardened option; no setting enables hardened for new sessions; src/main shows hardened set only via interactive create config."
    },
    {
      "operation": "Alternative surfaces",
      "observedAt": 1794834263000,
      "result": "Windows PC cannot run hardened (macOS only); test Mac has no Codex login; driving the installed Harness app is prohibited."
    }
  ],
  "alternative": "Exec pipeline was forced on the dev app and passed the observable behaviour; it is not the hardened setting or the installed build.",
  "expectedResult": "Session runs both prompts: progress visible while busy, chronological output, no duplicate transcript, failed command distinguishable from a crash, hardened mode-selection log wording.",
  "implementation": "Add an agent-reachable disposable-session control in the installed app (for example a hardened flag on a test-owned session or automation), with cleanup and a read-back of messages and mode-selection log; test that ownership, hardened flag and cleanup work."
}
</capability_evidence>

## Refined design (round 1)

**Reproduction.** The 11 Nov run showed `createInstance({provider:'codex', hardened:true})` fails inside a Harness session with `sandbox_apply: Operation not permitted` because macOS refuses a sandbox started inside another one. `dev-app.js status` (16 Nov) shows no copies on the test Mac or PC. Reading the real path: hardened is set only from `InstanceCreateConfig.hardened` (`instance-create-builder.ts:112`); the IPC create handler passes it (`instance-handlers.ts:119`), but the child path does not: `SpawnChildPayloadSchema` (`packages/contracts/src/schemas/orchestration.schemas.ts:14`) has no such field and `createChildInstance` (`instance-manager.ts:2268`) never passes `hardened`, so a `hardened:true` in a `spawn_child` command is silently dropped. Automations were checked and rejected as the route: strict arg schema, caller-authority rules, and `read_session` refuses a non-related session.

**Chosen route.** A child session is created by the app's own main process, so it is outside the sandbox of the agent that asked for it. A parent already owns, reads (`get_child_output`, `read_session` "related" scope) and terminates (`terminate_child`, ownership-checked) its children. So the smallest control is one new field on the existing command: `spawn_child` `hardened:true`.

**Files.**
- `packages/contracts/src/schemas/orchestration.schemas.ts`, `orchestration-protocol.types.ts`: add `hardened?: boolean`.
- `src/main/orchestration/hardened-child-gate.ts` (new, pure): refuses remote targets (`node`, or a parent on a worker), providers not in `isHardenedModeSupported`, an unresolved `auto` provider, and non-macOS hosts, with plain messages. Hardening only restricts, so no authority is raised and role policy is unchanged.
- `instance-orchestration.ts`: validate and pass the field. `instance-manager.ts` `createChildInstance`: run the gate, then `hardened:true` into `createInstance`.
- `orchestration-command-signature.ts`: include `hardened`, so a hardened spawn is not deduped against an ordinary one.
- `orchestration-handler.types.ts` + `get-children` callback: `ChildInfo.hardened`, so the parent can read back that the flag took.
- `docs/plans/livetest-capability-repair-runbook.md`: new row naming this route.

**Acceptance.** Gate spec (accept/refuse matrix). Manager spec: hardened child is flagged and registered; ordinary child is not; remote, unsupported and `auto` refused with nothing created. Orchestration spec: field reaches validation, `get_children` reports it. Signature spec. Terminate/ownership and registry cleanup on removal are existing behaviour, covered by a test that a hardened child is cleared on termination. Runtime probe: dev app on the test Mac, `spawn_child` hardened Claude child reaches a turn (Seatbelt applied outside the fence) and Windows refuses with the gate message.

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action. (Checks done; the plan stays open.)
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Create a fresh local Codex session with hardened mode enabled and observe the progress prompt and failed-command prompt in the installed app",
  "expectedResult": "Session runs both prompts: progress visible while busy, chronological output, no duplicate transcript, failed command distinguishable from a crash, hardened mode-selection log wording."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.
