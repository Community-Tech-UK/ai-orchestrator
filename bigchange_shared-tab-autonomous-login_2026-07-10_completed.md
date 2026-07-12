# bigchange: autonomous login on shared existing tabs (procurement portals)

Status: IMPLEMENTED (Option A) — shipped 2026-07-10 as `browserGateway.allowSharedTabCredentialFill` + node-scoped standing authorizations (see `browser-gateway-service.ts`, `browser-form-fill-operations.ts`, `browser-gateway-service.credentials.spec.ts`; the follow-on secret broker is in `docs/superpowers/specs/2026-07-11-procurement-secret-broker-design_completed.md`). All unit/integration specs pass. Remaining live check: the manual windows-pc DBT Jaggaer end-to-end login from the test plan below.
Owner prompt: paste the "Implementation prompt" section below into a fresh AIO/Harness
session opened in `~/work/orchestrat0r/ai-orchestrator`. It is self-contained.

---

## The hole (verified against source, not inferred)

AIO has a complete autonomous-login subsystem — credential vault, per-origin standing
authorizations, TOTP, and an email-code (2FA) reader. It is **hard-denied on shared
existing Chrome tabs** and only runs on agent-owned *managed* profiles. Every real-world
procurement portal we use (In-Tend, Jaggaer/DBT, Constellia, PCS, etc.) runs on the
user's **real shared Chrome** on the `windows-pc` node, because that is where the
registered vendor sessions and accounts live. Net effect: the agent can drive the entire
portal *after* login, but the human has to type every password by hand — which directly
contradicts the standing authorization "autonomous login/register/apply on ALL tender
portals" (see James's memory note `procurement-autonomy-authorization`).

This is a deliberate architectural boundary, not a bug. But it is the wrong boundary for
the procurement use case, where the user has given explicit standing consent.

### Evidence (file:line)

- `src/main/browser-gateway/browser-form-fill-operations.ts`
  - `:75` `executeFillPlanOperation` → deny `execute_fill_plan_managed_profile_only` when `hasExistingTab(...)`
  - `:186` `fillCredentialOperation` → deny `fill_credential_managed_profile_only` when `hasExistingTab(...)`
  - `:311` `createAgentCredentialOperation` → deny `create_agent_credential_managed_profile_only` when `hasExistingTab(...)`
  - Critically, the `hasExistingTab` deny at `:186` returns **before** the per-origin
    authorization check at `:217` (`authorizations.check({ profileId, origin, purpose })`).
    So even a valid standing authorization cannot currently unlock a shared tab.
- `src/main/browser-gateway/browser-credential-authorization-store.ts`
  - `:9` comment: authorizations are *"scoped to agent-owned managed profiles."*
  - `:15` `CredentialPurpose = 'login' | 'register' | 'totp' | 'email_code'`
  - `:24` `CredentialAuthorization { profileId, allowedOrigins, purposes, folder(Bitwarden), ... }`
  - `:114` `check(input)` already resolves (profileId, origin, purpose) → authorized/denied.
    The machinery to gate a shared-tab fill by explicit consent already exists; it is just
    never reached for shared tabs.
- `src/main/browser-gateway/browser-action-classifier.ts`
  - `:132-133` any field whose context contains a PASSWORD_WORD (`password`, `passkey`,
    `token`, `secret`) → `credential` + `hardStop:true` + `credential_or_manual_challenge`.
    This is why even typing the *non-secret* username on a login form hard-stops to
    `requires_user`: the login form is classified credential-class as a whole.

### Current escape hatch (what the agent does today)

`browser.request_user_login` (manual handoff) — the human types the password, the agent
resumes. Works, but it is the thing we want to make optional for authorized portals.

---

## Fix options

### Option A — Authorized shared-tab credential fill (recommended, matches user intent)

Allow `fill_credential` (and the credential steps of `execute_fill_plan`) on shared
existing tabs **only when all of the following hold**:

1. A live, unrevoked `CredentialAuthorization` covers (profileId, live origin, purpose) —
   the check already at `browser-credential-authorization-store.ts:114`.
2. A new explicit per-profile opt-in flag, e.g. a setting
   `browserGateway.allowSharedTabCredentialFill` (default **false**), OR a per-profile
   allowlist of origins the user has ticked "the agent may sign in here on my behalf".
3. The action is written to the audit log with the resolved origin, purpose,
   authorizationId, and profileId (reuse the existing audit path).

Implementation sketch:
- Widen the authorization store's scope note and `check()` to permit shared-tab profiles
  when the opt-in is set (keep managed-profile behaviour unchanged).
- In `fillCredentialOperation`, replace the blanket `hasExistingTab` deny at `:186` with:
  if `hasExistingTab` AND NOT `allowSharedTabCredentialFill(profileId, origin)` → keep the
  current deny; else fall through to the existing origin + authorization + TOTP/email-code
  path (which already resolves the secret in-process and never returns it to the model).
- Do the same for the credential steps inside `executeFillPlanOperation` (`:75`). Leave
  `create_agent_credential` (`:311`) managed-only for now (creating *new* accounts on a
  human's real browser is a bigger blast radius; out of scope).
- Classifier: no change needed. Once the vault path is allowed, the agent uses
  `fill_credential` (which is a first-class credential primitive) instead of raw
  `browser.type` into a password field, so the `credential_or_manual_challenge` hard-stop
  on raw typing is fine to keep as a backstop.

Safety invariants to preserve:
- The secret is resolved in the main process and typed straight into the page; it is never
  sent to or returned from the model (unchanged from the managed path).
- No origin without an explicit standing authorization can be auto-filled.
- Default remains fully locked down; the shared-tab path is opt-in per profile/origin.
- Full audit trail per fill.

### Option B — Dedicated managed "procurement" profile

Stand up one agent-owned managed Chrome profile, log each portal in once (agent-owned),
and run all future portal automation there. No shared-tab exception needed; full
autonomous login/TOTP/2FA immediately. Downsides: every existing portal registration
currently lives in the user's real Chrome session and would need re-login (some portals
tie the account to the user's identity/email 2FA), and the user loses the ability to
eyeball what the agent is doing in his own browser window.

### Recommendation

Ship **Option A**. It is the minimal change that honours the existing standing
authorization, keeps the human's real registrations, preserves every safety invariant,
and reaches code paths that already exist. Consider Option B later only if we want a fully
unattended procurement lane with no shared browser at all.

---

## Acceptance criteria

- With `browserGateway.allowSharedTabCredentialFill` enabled for the `windows-pc` profile
  and a standing `login` authorization for `in-tendhost.co.uk` / `uktrade.app.jaggaer.com`
  / `constellia.net`, `browser.fill_credential` succeeds on the shared tab and logs in,
  with no `fill_credential_managed_profile_only` deny.
- With the flag OFF, behaviour is byte-for-byte identical to today (deny + manual handoff).
- No credential value ever appears in a tool result, model-visible payload, or the audit
  log (assert in a spec).
- New/updated specs alongside `browser-gateway-service.credentials.spec.ts` and
  `browser-credential-authorization-store.spec.ts` cover: flag off = deny; flag on +
  authorization = allow; flag on + NO authorization = deny; audit record shape.

## Test plan

- Unit: authorization `check()` with shared-tab profile + opt-in; classifier unchanged.
- Integration (spec): `fillCredentialOperation` with `hasExistingTab=true` under both flag
  states and both authorization states.
- Manual: on `windows-pc`, DBT Jaggaer login end-to-end with the flag on and a seeded
  authorization for `uktrade.app.jaggaer.com` (folder `AIO-Agent`, username
  `shutupandshave`).

## Out of scope

- `create_agent_credential` on shared tabs (new-account creation) stays managed-only.
- CAPTCHA / hardware-key flows (still human, via the existing escalation queue).

---

## Implementation prompt (paste into a fresh AIO session)

> In `~/work/orchestrat0r/ai-orchestrator`, implement "Option A" from
> `bigchange_shared-tab-autonomous-login_2026-07-10.md`: allow `browser.fill_credential`
> and the credential steps of `browser.execute_fill_plan` to run on shared existing tabs
> when (a) a new per-profile opt-in setting `browserGateway.allowSharedTabCredentialFill`
> is enabled for that profile/origin AND (b) a live standing `CredentialAuthorization`
> covers (profileId, live origin, purpose). Keep `create_agent_credential` managed-only.
> Preserve all safety invariants: secret resolved in-process, never returned to the model,
> full audit record, default-off. Update
> `browser-credential-authorization-store.ts` (scope), `browser-form-fill-operations.ts`
> (the `hasExistingTab` denies at lines ~75 and ~186), and add/extend specs
> (`browser-gateway-service.credentials.spec.ts`,
> `browser-credential-authorization-store.spec.ts`) for: flag-off deny, flag-on+authorized
> allow, flag-on+unauthorized deny, and "no secret leaks to model/audit". Read the four
> files named in the Evidence section first; do not change the classifier. Run the
> browser-gateway spec suite (quiet reporter) and report pass/fail.
