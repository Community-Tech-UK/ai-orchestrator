# MiMo Token Plan allowance in token-usage-monitor and AIO — Spec

Status: complete (implemented and verified 2026-09-23; the live-app UI checks are
deferred to the livetest doc linked from the plan)
Plan: [2026-09-23-mimo-token-plan-allowance_plan_completed.md](./2026-09-23-mimo-token-plan-allowance_plan_completed.md)
Live test: [2026-09-23-mimo-token-plan-allowance_livetest.md](./2026-09-23-mimo-token-plan-allowance_livetest.md)

**2026-09-24 live-test update:** Check 3 passed. Check 4 exposed LT-650 (stale Token Plan
numbers after changing to a non-Plan model); the fix is committed at `39d245ba` and was
confirmed live through the quota IPC. The cleared Settings row was supported by source and
component-test evidence but was not independently rechecked on screen. Checks 1 and 2 still
need a renewed console session. These are tracked in the linked live-test document; the AIO
implementation is committed, while this spec and its plan remain untracked.

## Context

James runs MiMo models (OpenCode CLI with `xiaomi-token-plan-ams/*`, e.g.
`mimo-v2.6-pro`) under his **MiMo Token Plan** subscription (the plan shown at
`platform.xiaomimimo.com/#/console/plan-manage`; MiMo Code's own docs tie CLI
usage to this plan). He wants that allowance — used/total tokens and period end —
shown in the standalone token-usage-monitor (menu bar + `usage`) and in AIO's
provider quota (chip + settings), alongside Claude/Codex/etc.

The 2026-09-22 OpenCode provider work recorded "no quota source" (Decision 8;
Task 3.7 skipped): the Token Plan API key is refused by the console quota
endpoints and the API host exposes no usage endpoints. Re-investigated
2026-09-23 via a different route — the console endpoints accept the browser
session cookies from James's Chrome profile on this Mac — and verified live
against his account. This spec covers building both consumers on that source.

## Verified contract (live, 2026-09-23)

1. Endpoints: `GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage?userId=<userId>`
   and `GET https://platform.xiaomimimo.com/api/v1/tokenPlan/detail?userId=<userId>`.
2. Auth is console session cookies only (no `Authorization`): `api-platform_serviceToken`,
   `api-platform_slh`, `api-platform_ph` (host `.platform.xiaomimimo.com`) plus
   `userId` (host `.xiaomimimo.com`). Dropping the `userId` cookie returns
   `401 {code, loginUrl}` — the same shape the API-key attempt gets. The full
   four-cookie set returned `200 {code: 0, data: …}` from this machine.
3. Cookie source: Chrome `Default/Cookies` SQLite. Encrypted values are
   `v10` + 16-byte prefix + 16-byte IV + AES-128-CBC (PKCS#7), key =
   `PBKDF2-HMAC-SHA1(utf8(Chrome Safe Storage password), "saltysalt", 1003, 16)`;
   the password is the Keychain generic password `Chrome Safe Storage` /
   account `Chrome`. Verified by decrypting 16 cookies to clean plaintext and
   by the live 200 above.
4. `/usage` body: `data.monthUsage.{percent, items:[{name, used, limit, percent}]}`
   and `data.usage.{percent, items:[…]}`. Live item names: `month_total_token`,
   `plan_total_token`, `compensation_total_token`. Live figures at
   verification: `plan_total_token` used 197,885,860 / limit 38,000,000,000.
5. `/detail` body: `data.{planCode, planName, currentPeriodEnd, expired,
   enableAutoRenew, hasAutoRenewSubscribed, clawEnabled, clawPurchased,
   clawPeriodEnd, autoRenewDiscount}`. Live: `planName: "Pro"`,
   `currentPeriodEnd: "2026-10-22 23:59:59"`, `expired: false`.
6. `percent` fields are fractions 0..1 and inconsistently rounded (0.0052 and
   0.01 for the same used/limit ratio) — percentages must be derived from
   `used`/`limit`, never trusted from `percent`.
7. Date strings are naive and the console parses them as UTC
   (`dayjs.utc(value.replace(/Z$/, ""))` in the console bundle), which matches
   the monitor's existing naive→UTC rule.
8. API-key auth stays dead (re-verified 2026-09-23): both endpoints 401 with
   the Token Plan key; `token-plan-*.xiaomimimo.com` has no usage/limits
   endpoints (`/v1/usage`, `/v1/dashboard/billing/*`, `/v1/tokenPlan/usage` all
   404) and no rate-limit/usage response headers on `/v1/models`,
   `/v1/chat/completions` or `/anthropic/v1/messages`.
9. The `api-platform_*` cookies are Chrome session cookies
   (`is_persistent = 0`): they disappear on a clean Chrome exit until the
   console is signed in again.

## Requirements

- R1. token-usage-monitor shows a **MiMo Code** section (tool key `mimo`,
  abbreviation `MC`) with one window per reported token bucket:
  `plan_total_token` → "plan", `month_total_token` → "monthly",
  `compensation_total_token` → "compensation" (only when its limit is > 0),
  unknown bucket names surfaced with underscores turned into spaces. Window
  detail is `used/limit` in human token units; every window resets at
  `currentPeriodEnd`; `status` is the plan name (e.g. `Pro`).
- R2. The background poller polls both endpoints on its existing 10-minute
  cycle and writes `state.json` itself (the Codex pattern: the poller owns
  writes when one snapshot needs two responses). The Keychain read of
  `Chrome Safe Storage` goes through the existing blocked/attention machinery,
  so the menu shows "Keychain access needed" and `poller.py --grant mimo`
  triggers the one-time "Always Allow" prompt.
- R3. Cookie and token values are never logged, printed, written to the repo,
  or persisted anywhere by these changes. The Chrome cookie DB is opened
  read-only.
- R4. When Chrome holds no console session (closed, never signed in) or the
  session is rejected (401), the poll is skipped with a log line and the last
  snapshot ages naturally — never a fabricated 0 % and never a wiped snapshot.
- R5. AIO reports the same allowance as a `ProviderQuotaSnapshot` for provider
  `opencode` (the shape Task 3.7 approved), gated on the configured OpenCode
  model whose provider id starts with `xiaomi-token-plan-`. Windows carry real
  token counts (`unit: 'tokens'`, `kind: 'calendar-period'`, `overage: false`),
  `source: 'admin-api'`, `plan` = plan name, `resetsAt` = `currentPeriodEnd`.
- R6. AIO prefers its native probe and falls back to token-usage-monitor's
  `state.json` (`mimo` entry aliased to `opencode`) through
  `CompositeQuotaProbe`, the same enhancement path as the other providers.
- R7. A missing or rejected console session in AIO is `ok: false` with
  `needsReauth: true` and an error naming the fix ("sign in to the MiMo console
  in Chrome"), never numbers.
- R8. Tests in both repos cover the normalizer/parsers against recorded
  placeholder shapes, plus failing request and changed-shape cases. Fixtures
  use obvious placeholders, never realistic cookie/token values.
- R9. Docs updated: token-usage-monitor `README.md` (+ `install.sh` final
  steps), AIO `docs/DEVELOPMENT.md` (MiMo section), and
  `docs/provider-parity-checklist.md` (the `opencode` quota cell).

## Decisions

1. **Browser-session cookie poll — the only live source.** The console quota
   API is session-cookie-only (contract 2/8). Reading the cookies from Chrome's
   cookie store read-only is the same class of credential handling as the
   existing Cursor session-token reader, and the one-time Keychain approval UX
   already exists. Rejected alternatives: scraping the console through the
   Browser Gateway (not viable in a 10-minute background poll, and
   token-usage-monitor cannot drive it) and manual entry (the numbers go stale
   silently).
2. **The poller writes `mimo` state directly** (Codex pattern) because one
   snapshot merges two responses (`usage` + `detail`) and `capture.py` parses
   one flow at a time. The shared normalizer lives in `capture.py` beside
   `grok_snapshot_from_billing`, as those shared parsers do.
3. **Percentages are derived from `used`/`limit`** and the provider `percent`
   fields are ignored (contract 6).
4. **AIO files the snapshot under provider `opencode`**, per Task 3.7's
   approved design — OpenCode is the CLI and the Token Plan is its backend when
   the model is `xiaomi-token-plan-*`. A dedicated `mimo` quota `ProviderId`
   was considered and rejected for v1: it needs CLI-install mapping and churn
   across chip/settings/alerts purely for a row label.
5. **Display name "MiMo Code"** (key `mimo`, abbr `MC`) matches James's
   phrasing; the plan name rides `status` in the monitor and `plan` in AIO,
   as Copilot's plan label does.
6. **The compensation bucket is granted renewal credit, not paid overage**
   (the console's own tooltip describes plan-renewal compensation), so every
   MiMo window sets `overage: false` explicitly.

## Out of scope

- The MiMo Code fork (`mimo` binary) as a provider in AIO or a wrapped tool in
  the monitor (still out of scope from the OpenCode provider spec).
- Claw add-on windows (not enabled on James's plan; the API reports no usage
  numbers for it).
- Multiple MiMo console accounts / account pools.
- Keeping a console session alive while Chrome is closed (v1 skips the poll and
  lets the snapshot age; a Keychain-cached session can be a follow-up).

## Risks

- **Session-cookie lifetime** (contract 9): with Chrome closed or the session
  invalidated, no fresh polls happen until the console is signed in again. R4/R7
  define the degraded behaviour; the display's "updated Xh ago" is the signal.
- **First Keychain prompt**: `Chrome Safe Storage` needs a one-time "Always
  Allow", exactly like the existing Cursor/Claude items.
- **Chrome layout/encryption changes**: readers fail closed to "no session"
  (skip + age), never to wrong numbers.
