# Computer Use Autonomy Level — Specification

**Status:** COMPLETED (2026-08-26). Implemented and independently gated; real-app checks deferred to the livetest doc linked from the plan.
**Implementation plan:** [2026-08-26-computer-use-autonomy-level_plan_completed.md](../plans/2026-08-26-computer-use-autonomy-level_plan_completed.md)
**Date:** 2026-08-26
**Owner:** James

## 1. Problem

James authorised local Mac browser and UI control outright on 2026-08-26 and asked for the tooling
to stop blocking it: *"Fix the tooling then. We're trying to build something autonomous."*

Three separate hard-coded blocks in the desktop gateway deny actions unconditionally. None of them
is configurable, and none offers an escalation path — they return `denied` and stop.

**B1 — App hard-deny (`desktop-app-policy.ts:11-63`).** A constant regex list and bundle-ID list.
`decideDesktopAppPolicy()` checks it *before* the configured allow/deny lists, so no setting can
override it. It blocks the Harness app, every terminal, every provider app (Claude, Codex, Gemini,
Copilot, Cursor, Antigravity), System Settings, Keychain, every password manager, and anything
matching `/\bwallet\b/`, `/\bpayment\b/` or `/\bstocks\b/`.

**B2 — Hotkey deny (`desktop-input-policy.ts:7-29`).** `isDeniedHotkey()` blocks **Enter, Return and
Space** outright, alongside genuinely destructive combinations (`cmd+q`, `cmd+option+escape`,
`cmd/shift+delete`, `ctrl+cmd+power/eject/delete`). A UI cannot be operated without Enter or Space,
so this is the single largest practical blocker to autonomous desktop work.

**B3 — Sensitive-action deny (`desktop-input-controller.ts:630`).** Any element classified sensitive
by `isSensitiveObservedElement()`, or any text matching `isSecretLikeInput()`, is denied. That
covers every sign-in button, submit control and high-entropy string.

### 1.1 Two of these are over-broad regardless of policy

Independent of the autonomy question, B1's matching is wrong. The haystack includes
`executablePath`, and the patterns include bare `/\bsecurity\b/`, `/\bprivacy\b/`, `/credential/`,
`/\bshell\b/` and `/\bstocks\b/`. Any application whose *path* happens to contain one of those words
is denied with reason "built-in hard deny" and no way to allow it. This is a false-positive bug and
is fixed here whatever autonomy level is chosen.

## 2. Goal

Replace three unconditional denials with one comprehensible policy control, defaulting to the level
James asked for, while keeping a genuine kill switch and an honest audit trail.

## 3. Non-goals

- Changing the OS-level TCC requirement. Accessibility and Screen Recording grants are still granted
  by a human at the macOS prompt; no setting here affects that.
- Changing the browser gateway's separate approval model.
- Removing the audit log or the redaction layer.

## 4. Design

### 4.1 One setting, three levels

Add `computerUseAutonomyLevel: 'guarded' | 'trusted' | 'unrestricted'`, default **`'trusted'`**.

A single enum is chosen over five booleans deliberately: `AppSettings` already carries 186 keys of
which 66 have no UI, and adding a cluster of interacting booleans to a security surface makes the
effective policy impossible to read off the settings page.

| | `guarded` | `trusted` (default) | `unrestricted` |
|---|---|---|---|
| App hard-deny list | enforced (today's behaviour) | self-control guard only | none |
| Enter / Space | denied | **allowed** | allowed |
| Destructive hotkeys (`cmd+q`, force-quit, `ctrl+cmd+power`) | denied | denied | allowed |
| Sensitive elements (sign-in, submit, payment) | denied | **allowed** | allowed |
| Secret-like typed text | denied | **allowed** | allowed |

The configured `computerUseAllowedAppsJson` / `computerUseDeniedAppsJson` lists keep working at
every level, and the configured denylist still wins over the allowlist.

### 4.2 The self-control guard

At `trusted`, one entry of the old hard-deny list survives: **the Harness application itself**.

This is not conservatism about James's authorisation. Harness's own window is where Computer Use
grant approvals and browser approval prompts are rendered. An agent that can click them approves its
own escalations, which does not make the system more autonomous — it makes
`computerUseRequireApprovalForInput`, the browser approval flow and every grant record report a
human decision that never happened. The audit trail would then be actively misleading rather than
merely permissive.

The lever James actually wants for "stop asking me" is the existing
`computerUseRequireApprovalForInput: false`, which removes the gate honestly and leaves the audit
saying so.

`unrestricted` removes the guard as well, for driving Harness's own UI in a livetest. It is a
deliberate, named choice rather than a side effect.

### 4.3 Agents cannot raise their own level

`computerUseAutonomyLevel` joins the human/GUI-only list in `settings-control-policy.ts:70-84`
alongside every other `computerUse*` key, so the settings CLI and MCP tool surface cannot change it.
An agent that could set itself to `unrestricted` would make the level meaningless.

### 4.4 Audit

Every allow that would have been denied at `guarded` is audited with the level that permitted it, so
the log distinguishes "was allowed" from "was allowed *because the level was raised*".

## 5. Acceptance

1. At `trusted`: Terminal, System Settings, Keychain, password managers and provider apps resolve to
   `needs_approval` (or `allowed` when on the configured allowlist) rather than `denied`; the Harness
   app still resolves to `denied`.
2. At `unrestricted`: the Harness app resolves like any other app.
3. At `guarded`: behaviour is byte-for-byte today's, including all bundle IDs.
4. Enter and Space are permitted at `trusted`; `cmd+q` and force-quit are not.
5. At `unrestricted`, destructive hotkeys are permitted.
6. Sensitive elements and secret-like text are permitted at `trusted`, denied at `guarded`.
7. An app whose executable path merely contains "security", "privacy", "credential", "shell" or
   "stocks" is **not** denied at any level, including `guarded`.
8. `computerUseAutonomyLevel` is rejected by the settings CLI/MCP write surface.
9. Typed text is still redacted out of every audit row.

## 6. Risks accepted

- At `trusted` an agent can type into a password field and click sign-in. This is the explicit
  intent. Typed text remains redacted from the audit store by `redactDesktopMetadata`, whose key
  pattern already covers `text`, `password`, `secret`, `token`, `key` and `credential`.
- At `unrestricted` an agent can quit applications and approve its own grants. Named and documented.
