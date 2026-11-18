# Capability repair 5197615a-ec72-4741-8938-0fd24e274e9b

## Status

On main: yes (this landing commit)
Implemented, awaiting independent review and runtime probe. Reproduced: no test computer had Copilot on 16 Nov. Code cannot supply a person's sign-in, so the repair is `dev-app.js start --needs <tools>` (with `remote-run.sh devapp-providers`): only a computer with each tool installed takes the copy, never this Mac, exit 3 with nothing sent when none has them. Installation only, not sign-in. Gates and 110 related tests pass (re-run 18 Nov). On 18 Nov the test Mac reports claude, codex, copilot, opencode, cursor-agent installed (someone provisioned it), so `--needs codex,copilot` now selects it; the exit 3 path was re-proved with `--needs grok`. Open: the checker's probe was parked only because the test Mac stayed above its load limit (the launcher waits by design); rerun `--needs claude` or `--needs codex,copilot` with `--checked-tree` when load is under 15. Human boundary left: Codex/Copilot sign-in. Evidence: the `_history.md` beside this plan.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "signed-in-codex-copilot-acp-dev-app",
  "check": "Check 1 and Check 15: Codex second opinion and real Copilot credit ledger; parts of checks 2, 3, 5, 9, 10, 13",
  "requiredAction": "A dev-app copy with signed-in Codex, Copilot and ACP providers",
  "platform": "any",
  "provider": "codex",
  "classification": "setup",
  "attempts": [
    {
      "operation": "dev-app.js start on this worktree, then getStartupCapabilities() over CDP",
      "observedAt": 1794833692108,
      "result": "Copy ran on the Windows PC; provider.any unavailable; Claude, Codex, Antigravity and Copilot each reported not installed."
    },
    {
      "operation": "Reviewed the 14 November run on the test Mac copy",
      "observedAt": 1794660892000,
      "result": "Claude usable; Codex, Copilot, ACP and second reviewers not available there."
    }
  ],
  "alternative": "Component and protocol tests run in-loop; the real provider turns cannot be substituted.",
  "expectedResult": "Codex, Copilot and ACP sessions run in the copy and the check steps can be driven over CDP.",
  "implementation": "Provide a test computer whose dev-app copy can read signed-in Codex and Copilot logins (the runbook notes SSH cannot read a Mac keychain), or add a disposable authenticated provider fixture to dev-app.js start --mac."
}
</capability_evidence>

## Reproduction and refined design

Reproduced on 16 Nov 2026 over SSH (read-only: `command -v` in the login shell, and file-existence checks only, no file contents). Neither the test Mac (`ct-test-mac`, Darwin arm64) nor the Windows PC's Linux space has `codex`, `copilot`, `gh`, `opencode`, `gemini`, `agy`, `cursor-agent` or `grok` on its login PATH, and neither has `~/.codex/auth.json`, `~/.copilot` or `~/.config/gh/hosts.yml`. Only `claude` exists, on the test Mac (`~/.local/bin`, found by `zsh -l -c`). `dev-app.js start` has no way to say what a check needs: it starts a 5 to 25 minute build, and the missing tools only show up afterwards over CDP.

Code cannot create the missing thing. Installing Codex/Copilot and signing them in needs a person's account and credentials, which this plan does not grant, and a fake "authenticated" fixture would not be a real provider turn. So the bounded repair is the control that makes the requirement explicit and routes to a computer once one is provisioned:

- `scripts/remote-checks/remote-run.sh`: new `devapp-providers` command (no arguments, so nothing to inject). It asks the account's login shell for its PATH, adds the common install folders (`~/.local/bin`, Homebrew, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`, `~/.nvm/versions/node/*/bin`), and prints one result line `{"installed":[...]}` naming which of the fixed list claude, codex, copilot, gemini, agy, opencode, cursor-agent, grok are installed. Installed only: sign-in is read by the copy itself (a Mac login keychain cannot be read over SSH).
- `scripts/remote-checks/dev-app.js`: `start --needs <name,name>` (names from that fixed list; rejected otherwise, and only on `start`). Only computers with every named tool installed may take the copy. `--needs` never uses this Mac (like `--packaged`), because this Mac cannot be asked. If every eligible computer answered and none qualifies, start sends nothing, names what each lacks and exits 3. If some computer could not be asked, it waits as it does for busy ones.
- `docs/plans/livetest-capability-repair-runbook.md` and the usage text: document `--needs`, exit 3, and that it proves installation only.
- Tests in `dev-app.spec.ts`: argument parsing; start goes to a qualifying computer; skips one that lacks the tool; exit 3 sends nothing and names the gaps; an unreachable computer is not reported as lacking; a lacking computer's older copy of the same profile is stopped; the real `devapp-providers` script output against a stub PATH.

Not done, and why: installing providers and signing in on a test computer (human credentials and account authority; recorded as a capability gap).

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Check 1 and Check 15: Codex second opinion and real Copilot credit ledger; parts of checks 2, 3, 5, 9, 10, 13",
  "expectedResult": "Codex, Copilot and ACP sessions run in the copy and the check steps can be driven over CDP."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.

> Closure history: `capability-5197615a-ec72-4741-8938-0fd24e274e9b_plan_history_7d085e79bb62cd93db530c3f7977c51b8f6162865a6fbc32c4e3853536d19502_completed.md`.
