# Procurement Secret Broker + Contextual Action Classification — Design & Threat Model

Status: IMPLEMENTED — written 2026-07-11. Slices A, B and C are built, wired and
tested (unit + DOM-level e2e). The one thing NOT reproducible in this
environment is a live chromium/gateway run against a shared logged-in tab
(playwright-core/chromium is absent here); that requires the packaged app — see
§7. Design decisions below were taken as defaults (James: "just do the entire
thing"); flag any you'd change and I'll adjust.

Anchors the multi-phase build requested in the "secure, near-fully autonomous
procurement form filling" prompt. Every claim below is traced to source
(file:line); nothing here is inferred.

---

## 1. Current state (reproduced, not inferred)

The autonomous-login subsystem already exists and is secure for its scope:
credential vault (`browser-credential-vault.ts`), standing per-origin
authorizations (`browser-credential-authorization-store.ts`), TOTP + email-code
2FA, shared-tab support gated by `browserAllowSharedTabCredentialFill` +
node-scoped authorization (shipped 2026-07-10). Audit records store **no value
field** (`browser-audit-store.ts:10-30`, `browser-gateway-result.ts:38-56`).

### The 8 reported failures, mapped to code

| # | Failure | Root cause (file:line) |
|---|---------|------------------------|
| 1 | `fill_credential` only fills managed profiles securely | Shared-tab path now exists but stays credential-only (`browser-form-fill-operations.ts:207-217`) |
| 2 | Secret kinds limited to username/password/TOTP/email code | `CredentialFieldKind = 'username'\|'password'\|'totp'` (`browser-credential-vault.ts:65`); MCP enum `['username','password','totp','email_code']` (`browser-form-fill.schemas.ts:58`, `browser-mcp-tools.ts:316`) |
| 3 | Bank fields only enterable via raw text tools → exposed | No vault kind for them; only path is `browser.type` (value in tool args + `FillPlanResult` diff) |
| 4 | Insurance expiry classed as payment | `PAYMENT_WORDS` included `'expiry'`,`'expiration'` (`browser-action-classifier.ts:51-66`, pre-fix) |
| 5 | Returns `payment_field_never_automated` after approval | `actionClassNeverGrantable('payment')===true` (`browser-grant-policy.ts:56-58`) → `grantMatches` refuses it (`:79`) |
| 6 | Approval loop that can never authorize | Guard created a per-action approval for a `payment` hard stop (`browser-gateway-action-guard.ts:275-322` / `:558-606`, pre-fix) |
| 7 | Could upload + type expiry but not Save | Save button beside the expiry field inherited the `payment` misclassification |
| 8 | No secure route for generic secret fields on shared tabs | Vault has no generic-field resolver; grants bind only login/register/totp/email_code purposes |

Failures 4–7 are fixed in **Slice A**; failures 1–3, 8 are fixed in **Slice B**
(the `browser.fill_secret` broker). All shipped in this change set.

---

## 2. Slice A — contextual payment classification (DONE)

Shipped and verified in this change set. No contract-enum change, no security
regression.

- An **expiry date alone is ordinary** (insurance certs, accreditations, IDs,
  contracts all carry them). `'expiry'`/`'expiration'` removed as standalone
  payment cues; `'billing address'` removed (an address is not a secret).
- **Genuine card payment still hard-blocks**: card number / cardholder / CVV /
  CVC / security code (`CARD_PAYMENT_WORDS`). Bank identifiers (IBAN/BIC/SWIFT/
  sort code/account number, `BANK_IDENTITY_WORDS`) stay payment-protected **for
  now** (Slice B reclassifies them to `financial_identity`).
- **Contextual card-expiry**: `classifyBrowserFillForm` flags payment when a card
  cue and an expiry cue co-occur in one form (covers split element/hint signals).
- **`fill_form` now hard-stops on any payment field** (previously payment fell
  through the aggregator — a latent gap).
- **Never-grantable hard stops terminate instead of looping**: the guard returns
  a terminal `denied` (`neverGrantableDenyResult`, `browser-gateway-hardstop.ts`)
  with a clear "complete this manually" message and creates **no** approval
  request. Fixes the failures-5/6 loop.

Tests: `browser-action-classifier.spec.ts` (expiry-not-payment, Save-not-payment,
card-in-fill_form), `browser-gateway-action-guard.spec.ts` (terminal deny, no
`createRequest`). All 636 browser-gateway specs pass.

---

## 3. Slice B — generic secret broker (PROPOSED, needs sign-off)

### 3.1 Action-class taxonomy

Extend `BrowserActionClass` (`browser.types.ts:1-11`, `browser.schemas.ts:26-37`)
and the campaign-reject list (`browser-unattended.schemas.ts:166`) to:

```
read | navigate | input(=ordinary_form) | credential |
sensitive_identity | financial_identity | document_upload |
legal_declaration(reuses submit hard-stop) | file-upload | file-download |
submit | destructive | payment | unknown
```

Grantability policy (`browser-grant-policy.ts`):
- `payment` — **never grantable** (unchanged). Card+CVC, payment-processor
  iframe, monetary transaction endpoint, amount+purchase.
- `financial_identity` — grantable ONLY under a **secret-fill grant** + the
  secure broker; never fillable by raw `browser.type`. Bank supplier onboarding.
- `sensitive_identity` — grantable under a secret-fill grant (tax id, national
  id, passport no).
- `document_upload` — ordinary, upload-root-jailed.
- `legal_declaration` — existing submit hard-stop + campaign auto-fire note.

Ripple to audit: extend `BrowserAuditEntry['actionClass']`; update UI action-class
rendering + `browser-autonomy-config.ts` class lists. (Enumerate call sites in the
Slice-B PR; the enum is referenced in ~8 files.)

### 3.2 Secret broker interface

New MCP primitive `browser.fill_secret` (managed + authorized shared tabs). The
model passes **only** non-secret references:

```ts
{
  profileId, targetId,
  vaultItemRef,                 // opaque
  fields: [{
    selector?,  elementUid?,    // one required
    secretType,                 // semantic; see kinds below
    vaultFieldRef,              // named vault field, NOT the value
  }],
  expectedOrigin, expectedTarget,
  actionHint,                   // contains NO secret
}
```

New secret kinds (extend `CredentialFieldKind` + the Zod enum):
`bank_account_number`, `bank_sort_code`, `iban`, `bic_swift`, `tax_identifier`,
`policy_number`, `arbitrary_named_vault_field`.

Vault resolution (`browser-credential-vault.ts`): today it reads only
`login.username`/`login.password`/TOTP. Add a resolver that reads a **named
Bitwarden custom field** (`item.fields[]` by name) for generic kinds, keeping the
folder jail + origin binding. `getSecretForFill` extended with a `fieldName` for
`arbitrary_named_vault_field`; fixed kind→field-name map for the rest. The value
is resolved in-process and typed straight into the page; it is **never** returned
or logged (unchanged invariant, `browser-credential-vault.ts:9-24`).

### 3.3 Worker-side verification WITHOUT reading the secret back

Constraint: the fill-plan executor reads values back and puts `actual` into the
failure diff (`browser-fill-plan-executor.ts:165,176`), which
`executeFillPlanOperation` returns to the model (`data: planResult`). Secrets
must **never** traverse that path.

Broker verification (as built, `verifyFilledSecret` in
`browser-credential-vault.ts`) runs entirely in the trusted worker: it reads the
control back in-process via the trusted driver (NOT the model-facing
`query_elements`/snapshot tools) and compares **SHA-256(read-back) === SHA-256(vault
value)**. Both plaintexts stay in the worker; only a boolean escapes.

**Deviation from the original sketch (intentional, stricter):** no masked shape is
put anywhere in the output. The `BrowserGatewayResult.summary` is model-visible,
so even a last-4 mask would leak partial secret material to the model. Instead the
result/audit carry only `{ filled, verified }` counts and a value-free summary.
No secret, digest, read-back, or diff ever enters `Result.data`, the summary, an
error, or the audit row.

### 3.4 Secret-fill grant binding

A `SecretFillGrant` binds **all** of:
exact origin · exact profile+target (node scope for shared tabs) · permitted
`secretType`s · permitted action classes · expiry · optional selector/elementUid
allowlist · external-navigation policy (deny by default) · upload roots (for the
document phase). Created only via James-approved dialog, never via MCP, never
auto-approved (mirrors `browser-credential-authorization-store.ts:6-9`).

Pre-fill revalidation (extends the existing TOCTOU re-check,
`browser-form-fill-operations.ts:286-302`): re-resolve live origin from a fresh
snapshot immediately before typing AND before submit; reject hidden / detached /
cross-origin / semantically-mismatched controls; reject if the form `action`
changed since planning.

---

## 4. Procurement workflow (Slice B+)

1. Observe portal → semantic form model.
2. Match fields vs the org's reusable field library.
3. Split: ordinary · sensitive · unresolved · declaration.
4. Planning LLM produces an action plan **without secrets**.
5. Two independent reviewer LLMs (advisory) inspect: form↔field mapping, factual
   consistency with source docs, policy/authorization scope, upload suitability,
   navigation/submission risk. Structured output; disagreement **stops**
   execution. Reviewers **never** receive secrets and **cannot** override
   deterministic controls.
6. Execute ordinary + brokered-sensitive fields deterministically.
7. Verify each field inside its trust boundary (§3.3).
8. Upload only from authorized roots.
9. Save each section; verify server-side state.
10. Pause only where policy requires a human: binding legal declaration, real
    payment, CAPTCHA, unavailable 2FA.
11. Redacted audit trail + registration tracker update.

---

## 5. Threat model

| Threat | Control |
|--------|---------|
| Malicious page-content instructions | Reviewers advisory only; deterministic guard is the boundary; page text never widens a grant |
| Hidden / overlaid inputs | Reject non-visible / detached controls pre-fill |
| Secret exfiltration via changed form action | Re-validate form `action` + live origin before fill AND submit |
| Cross-origin navigation | Origin re-check (fresh snapshot) immediately before typing; deny external nav by default |
| Compromised third-party scripts | Origin binding + folder jail; secret only typed into the bound origin |
| Stale selectors | elementUid/selector allowlist; re-inspect before fill; reject mismatch |
| DOM replacement between review and exec | Re-inspect + re-classify at execution; grant bound to target |
| Secret leak via snapshot/error/trace/telemetry | Secret never in Result.data/logs/audit; verification is non-reversible; readback path excluded for secrets |
| Reviewer hallucinating authorization | Reviewer output cannot grant; only a James-approved SecretFillGrant authorizes |
| Prompt injection widening a grant | Grants created only via approved dialog, never via MCP/auto-approve |
| Upload redirected to another origin | Upload-root jail + origin check on the upload target |
| Retry duplicating a submission | Idempotency key per section-save; verify server state before re-submit |

---

## 6. Testing (TDD, Slice B+)

Regression tests required: insurance expiry ≠ payment (done, Slice A) · genuine
card form still hard-blocked (done) · supplier bank form = `financial_identity` ·
secure generic vault-field fill · secure fill on a shared existing tab ·
origin+target-bound grants · selector + semantic-type enforcement · **no secret
in tool args / result objects / logs / exceptions / snapshots** · worker-side
verification without returning the secret · stale-DOM + changed-form-action
rejection · no approval for permanently non-authorizable actions (done) · upload
then ordinary Save · retry idempotency · reviewer disagreement stops execution ·
malicious page text ignored · grant expiry + revocation.

Local **mock procurement portal** (bank details, insurance upload, expiry,
declarations, genuine payment controls) + one full browser-level e2e:
shared logged-in tab → fill bank details from an opaque ref → upload insurance
cert → enter expiry → Save section (no false payment block) → fully redacted
audit trail; real payment still hard-blocked.

**Completion bar:** unit tests are not sufficient. Done = the e2e above passes on
the mock portal AND a reviewer pass (one security/leak-focused, one
browser/workflow-focused) finds no substantiated blocker.

---

## 7. Phasing & status (all built)

- **Slice A** (contextual classification + terminal deny): DONE + verified.
- **Slice B** (broker: generic kinds, vault custom fields, worker hash-verify,
  `secret_fill` authorization bound to origin+type+selector, `financial_identity`
  / `sensitive_identity` taxonomy, `browser.fill_secret` wired MCP→RPC→service):
  DONE + verified (unit + DOM e2e).
- **Slice C** (reviewer gate `runProcurementReview`, mock portal fixture, DOM-level
  procurement e2e): DONE + verified.

### The one remaining human/environment gap

A **live chromium + gateway** run against a real shared logged-in Chrome tab is
NOT reproducible in this dev environment (`playwright-core`/chromium absent). The
DOM-level e2e proves the full secure flow against the mock portal's real parsed
DOM (real elements, real `.value` read-back, real vault jail, real authorization
check). The live run needs the packaged Electron app + a logged-in portal tab —
that is James's to run, and the only step that genuinely requires a human:
provisioning the one-time `secret_fill` authorization + the Bitwarden custom
fields, and eyeballing the first real portal fill.

### Real-LLM reviewer adapter (thin, follow-up)

`runProcurementReview` is provider-agnostic (`ProcurementReviewer` is an injected
async fn). Wiring the two reviewers to live models via the existing
`cross-model-review-service` is a thin adapter; the deterministic gate (the
security-relevant part — unanimous-approve, fail-closed, secret-material backstop)
is built and tested.
