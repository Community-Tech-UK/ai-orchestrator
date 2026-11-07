# Prompt: let agents finish emailed-code sign-ups and logins without James

Paste everything below the line into a fresh agent session started in
`/Users/suas/work/orchestrat0r/ai-orchestrator`.

---

## Goal

The Community Tech work finder must be able to register on, and sign in to, buyer portals that
send a one-time code by email, without handing the step to James. Today it cannot, and it turns
those steps into "only you can do this" questions for him. Fix the cause in Harness's browser
tool, then make the work finder use the fixed path and retry the British Council registration.

## What happened (verified 1 November 2026 from the live Work Finder board)

Card `british-council-bcms-103054-2026-10` (British Council business continuity tender, UK_1552,
clarifications close 10 November 23:59, bids close 24 November 12:00). The 30 October 18:36 to
18:41 UTC triage run on windows-pc:

1. Opened `https://tap.tcsapps.com/tap2/#/bc-supplier-registration`, entered
   `james@communitytech.co.uk`, clicked Validate Email.
2. The code arrived in the M365 inbox (uid 10452, 18:38:54 UTC).
3. The agent typed the code itself. That was allowed.
4. Clicking **Validate OTP** was refused: `requires_user`,
   `two_factor_unavailable_parked_to_escalation_queue` (gateway audit `56741629`).
5. The code expires after 10 minutes, so parking it for later is useless. The run stopped and
   asked James to register by hand.

Read the live card yourself before relying on this summary (read-only):
`ssh -o BatchMode=yes newdev 'cd ~/redesign-leads && set -a && . ./.env && npm --silent run work-finder:board-json'`
and pick the item with that id.

## Root cause as traced so far (confirm each point; do not trust it blindly)

- `src/main/browser-gateway/browser-action-classifier.ts`: `TWO_FACTOR_WORDS` includes `otp` and
  `verification code`, so any element whose context mentions them, including the plain submit
  button "Validate OTP", is classified `credential` + hard stop + `two_factor_challenge`.
- `src/main/browser-gateway/browser-gateway-action-guard.ts` (around the `!match.grant ||
  classification.hardStop` branch) sends every 2FA hard stop to `escalationResultForChallenge`
  in `browser-gateway-hardstop.ts`, which parks it. No grant or authorization can get past it.
- `src/main/browser-gateway/browser-reusable-credential-approval.ts` explicitly excludes 2FA
  from the reusable credential approval.
- Harness already has a sanctioned way to put an emailed code into the page without the model
  ever seeing it: `browser.fill_credential` with a field of kind `email_code`
  (`browser-form-fill-operations.ts`, `browser-credential-email-senders.ts`,
  `browser-email-code-reader.ts`, mailbox reader built in `browser-gateway/index.ts`
  `buildEmailCodeReader`). It needs a human-granted `email_code` credential authorization for
  the origin.
- So the gap is: Harness will fill the emailed code for the agent, but will never let the agent
  press the button that submits it. The flow can only end with James.

Secondary things to check, any of which would also stop the flow:

- `fill_credential` requires `vaultItemRef`. For a brand-new registration there is no saved
  login yet. Work out how the `register` purpose and the email_code-only path
  (`assertFillUnlocked` skips vault unlock when every field is `email_code`) are meant to work
  for a first sign-up, and make that path real if it is not.
- The mailbox reader uses the imap MCP account `james@communitytech.co.uk` (override
  `AIO_BROWSER_EMAIL_ACCOUNT`). Since the September M365 move, codes land in M365. Confirm that
  account reads the M365 inbox, not the old Krystal one.
- Sender domains default to the page origin's registrable domain (`tcsapps.com` here). If TAP
  sends from another domain (British Council or a mail platform), the authorization needs that
  sender listed. Find the real sender from uid 10452 headers (do not print the code).
- Why did raw typing of the code succeed when it should have gone through `fill_credential`?
  Decide whether that is a classifier gap worth closing so agents are pushed onto the
  sanctioned path.

## Required behaviour

- After Harness itself has filled an emailed code (or a TOTP from the vault) into a page through
  `fill_credential`, the agent may press that form's submit/verify button on the same tab and
  origin, within a short window, under the same live human-granted authorization. Audit it as
  an allowed action with a clear reason.
- Everything else stays as it is: codes the agent typed by hand, SMS codes, authenticator
  prompts on other devices, captchas, passwords, payments and legal declarations keep their
  current hard stops.
- When a 2FA step is still parked, the result and escalation must say the code will expire, so
  no one waits on a parked step that cannot resume.
- Design the rule as if it had always been the plan. No feature flags, no fallback paths.

Read `docs/decisions/rejected/` first and stop to ask James if this collides with a recorded
decision about two-factor automation.

## Work-finder side (repo `/Users/suas/work/communitytech/work-finding`)

- Find the instructions the 18:30 triage worker and tender-preparation runs follow
  (`AGENTS.md`, `work-finder/triage-rules.md`, the automation prompts in Harness). Make them say:
  use `browser.request_credential_access` for an `email_code` authorization, then
  `browser.fill_credential` with an `email_code` field, then press the verify button. Never type
  an emailed code by hand. Only raise a James question if the sanctioned path itself fails, and
  record the exact refusal reason.
- Store the new British Council login in Bitwarden as "British Council MyProcurement" with the
  `bw` CLI (read `~/.claude/docs/bitwarden-in-harness.md` first).
- Once the Harness fix is built and running, retry the British Council registration on
  windows-pc, read the UK_1552 pack, apply the bid rules, and update the card so the question to
  James is withdrawn. If the fix needs a Harness rebuild or restart that cannot happen now, record
  the retry in a `_livetest.md` per `AGENTS.md` and leave James's question on the card with a
  note.

## Rules you must follow

- All browser work runs on `windows-pc` through the Browser Gateway. Never use a browser on the
  Mac. If windows-pc is down, stop and say so.
- Do not create branches or worktrees. Do not commit or push unless James asks. Never restart
  Harness while sessions are live; build and verify, then tell James.
- Do not deploy the work finder (pushes to `main` under `apps/desk` deploy). Leave changes local
  and report them.
- Never print codes, passwords or Bitwarden values.
- Write a plan as an untracked `*_plan.md` beside this prompt and keep it updated.
- Reproduce first: a unit test showing the "Validate OTP" click parks after a successful
  `email_code` fill. Then fix, then show it passes.
- Gates: the full checklist in `AGENTS.md` (`npx tsc --noEmit`, `npm run typecheck:spec`,
  `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`,
  `npm run build:renderer`, `npm run test:quiet`), plus the work finder's own checks if you
  change it.
- Run the Completion Fresh-Eyes Gate with a fresh agent using `task-completion-gate`. Pay
  particular attention to security: the new allowance must not let an agent submit a code it
  typed itself, submit on a different origin or tab, or reuse an old fill.

## Report back in plain English

What was wrong, what changed, whether the British Council registration now works without James,
and anything left for him to do.
