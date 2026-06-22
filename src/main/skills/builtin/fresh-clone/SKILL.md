---
name: fresh-clone
description: Act as a first-time user following the README, surface the first hidden setup assumption.
triggers: ["/fresh-clone", "onboarding check", "fresh clone setup"]
version: 1.0.0
category: loop
effort: medium
---

# Fresh-Clone Onboarding Loop

A convergence loop that simulates a brand-new contributor following the setup
docs from a completely clean state, fixes one obstacle, and retries — until no
hidden setup assumption remains.

## Loop contract

- **OBJECTIVE** — find the first place a brand-new contributor would get stuck following the README/setup docs from scratch.
- **CHECKS** — read the documented setup steps in order and verify each is actually runnable and correct against the current repo (scripts exist, commands match `package.json`, native/ABI steps are documented).
- **STOP**
  - done — the first blocking setup assumption is identified, or all setup steps verify cleanly.
  - stalled — setup docs are absent or contradictory.
  - needs-permission — verification requires credentials, external accounts, or destructive machine changes.
- **GUARDRAILS** — do not change source code or configuration; documentation-gap reporting only.

## Behavior

1. Assume no prior knowledge and no pre-existing local state.
2. Walk the documented setup steps in order.
3. At each step, check the command/script actually exists and does what the docs claim.
4. Flag the first step that relies on undocumented context (env vars, prior installs, native rebuilds, hidden prerequisites).

## Output

A concise summary of the steps walked, the first blocking assumption found, a
suggested doc fix, and any other gaps observed.
