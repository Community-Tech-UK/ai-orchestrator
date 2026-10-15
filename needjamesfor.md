# Need James for — current routing plus historical handoff

**Status reconciliation — 2026-09-27.** The unchecked boxes below preserve a personal handoff last
updated on September 6; they are not today's action list. Do not execute an old sign-in, grant,
reset, release, deletion or restart instruction merely because it remains in the archive.

## Current routing

- [Human / external residuals](docs/plans/2026-09-27-livetest-human-external-residuals_livetest.md)
  owns 28 current campaign groups that genuinely need human judgment, production authority or an
  unavailable external system. RES-015 is a retired duplicate and is not part of that count.
- [Agent-runtime residuals](docs/plans/2026-09-27-livetest-agent-runtime-residuals_livetest.md)
  owns seven expensive or exclusive campaigns that remain safe for an autonomous agent.
- Other unsuffixed `*_livetest.md` owners remain active outside those two consolidations. Discover
  them from the current checkout; neither consolidated count is a total corpus count.
- The old [live-test backlog](docs/plans/livetest-backlog.md) is now a historical campaign record.
  Its 43/169 headline and routing tables must not be used as current status.

The latest evidence in an owning live-test file wins. For a transferred check, the applicable
2026-09-27 residual owns current status. Code completion alone never proves a live check passed.
Current `AGENTS.md` and the current task's authorization govern every action. Personal account and
device details, paths and measurements in the archive are context, not credentials or a current
inventory. This reconciliation inspected repository evidence and GitHub Actions history read-only;
it did not inspect or mutate live accounts, devices, releases or local databases.

## Supersessions checked against current owners

| Historical item | Current record |
| --- | --- |
| LT-196 needed a specification and product-contract decision | The [specification](docs/superpowers/specs/2026-09-06-lt196-correction-miner_spec_completed.md), [implementation plan](docs/superpowers/plans/2026-09-06-lt196-correction-miner_plan_completed.md) and [live owner](docs/superpowers/plans/2026-09-06-lt196-correction-miner_livetest_completed.md) are complete. Claude, Cursor and Grok scans passed. Do not commission the spec again. Only the narrow agent-runnable ACP no-output clause remains in AR-007. |
| Workboard Snooze still needed a live click-through | The [sibling-audit owner](docs/plans/2026-07-30-sibling-audit-round2_livetest_completed.md) records a real Snooze click passing on September 27. |
| Pick a skill threshold | The [September 23 measurement](docs/plans/2026-08-19-open-decisions-resolved.md#skill-injection-threshold--measured-2026-09-23) retains `0.65`; current code does too. A backend change requires new evidence, not another answer to the old menu. |
| Add a mobile timing hook | The [completed mobile owner](docs/plans/2026-07-25-mobile-queue-interrupt-draft_livetest_completed.md) accepts the existing unit evidence and no timing hook. Physical-device assertions moved to RES-013. |
| Accept split browser-disconnect evidence | The [completed reliability owner](docs/plans/2026-07-17-browser-gateway-reliability_livetest_completed.md) keeps that check closed. The authenticated offline-SPA residual moved to RES-002. |
| Delete old scratch snapshots | The historical backlog records the 16.2 GB deletion. This is not fresh disk inventory or authority to delete anything else. |
| Packaged-app debug port blocked four file-movement checks | The [file-movement owner](docs/plans/2026-07-16-worker-controller-file-movement_livetest_completed.md) closed six checks. Only removal of the live worker's safety-net transfer root remains, under RES-001 and explicit production-mutation authority. |
| Workspace Secret Card needed a disposable-secret sitting | The [owner](docs/plans/2026-08-23-workspace-secret-card_livetest_completed.md) records all four checks live-passed. Nothing remains for James. |
| `Harness.secure-credential-gate19.app` was staged for installation | The [credential owner](docs/superpowers/plans/2026-08-28-browser-gateway-secure-remote-credential_livetest_completed.md) records that bundle did not exist. The source checklist is closed; its remaining security-boundary campaign is RES-022. |
| MyTradeMail needed four production secrets | The September 23 deploy and Sentry/FCM configuration passed. RES-019 now owns only production ingestion, alert-delivery and inherited-IAM proof. |
| CI was red on the September 6 shard failures | The latest listed CI run was green on September 27 at `d0f23ebc`. Current HEAD `c3d72827` had no listed CI run at reconciliation time, so it is not claimed green. |
| Windows Browser Gateway was healthy on extension v0.2.19 | The current loaded version is v0.2.36. RES-023 requires an operator reload to v0.2.37 before its extension-bound checks. |
| The Local AI enrolment was unexplained | The conversation ledger establishes that James requested it in the same tool sequence that created it. The old yes/no question is closed. |
| LT-029 required a grant-root versus limitation decision | The safe limitation and credential-specific repair were implemented and regression-tested. A long-session OAuth refresh observation remains a live check, not a reopened product decision. |
| Six documents needed yes/no deletion decisions | That menu is retired. Unreachable clauses were deleted and still-valid security or device assertions were transferred to current residual owners. |
| LT-526 had never been live-confirmed | The [completed WS13 record](docs/plans/2026-07-13-fable-ws13_livetest_completed.md) records check 5 live-verified. |

## Archived September 6 handoff

Original inventory: 43 open livetest documents, 169 open checks.

The historical detail through September 24 lives in
[`docs/plans/livetest-backlog.md`](docs/plans/livetest-backlog.md), which consolidated the fifteen
dated status reports. It does not include every current owner and no longer determines status. The
following was the short list then believed to need James, not a statement that those items still
require him.

18 hands-on items and 12 decisions, ordered by payoff per minute. Eight items from the previous
version were removed as no longer yours, and one of its "already cleared" claims was wrong; see
the last two sections.

---

## 🟢 Historical quick-sitting requests (then estimated under 10 min each)

- [ ] **Ten minutes in Discord.** One bare DM, one Approve click, one "no" reply, one
      `select_option`, a forced failing turn, a file/image request, a tool-heavy turn with
      `channelToolHeartbeat` toggled, and one silent long turn for the completion ping.
      → Closes `discord-bot-parity` outright: 10 checks, a whole document, no engineering. Also
      closes the Discord halves of `sibling-audit-round2` (A5, B8/C8).
      The bot is live and paired (`Orchestrator Bot#1070`, 21 slash commands). Inbound messages are
      gated by a per-platform sender allow-list only your paired identity satisfies, so the app
      cannot simulate this against itself. The 2026-07-29 "no bot configured" verdict was wrong.

- [ ] **Sign in to Microsoft for the calendar connector.** Run `graph_calendar_connect` and complete
      the sign-in as `james@communitytech.co.uk`.
      → Verified again today: **zero connected accounts.** Turns checks 3 and 4 of
      `outlook-graph-calendar-connector` into agent work the moment it lands. Check 4 also needs you
      to supply the exact subject, dates, recurrence and attendees. Check 5 (Hotmail) needs an
      intentional Entra `signInAudience` change and is deferred by design.

- [ ] **Click "Sign in" once for a signed-out CLI provider.** `in-session-auth-repair` check 2.
      → The remaining gap is the `osascript` Terminal launch at
      `src/main/providers/provider-login-launcher.ts:178-190`. Terminal is on the hard-denied
      Computer Use list, so an agent structurally cannot trigger it, standing authorisation or not.

---

## 🟡 Historical sit-down requests

- [ ] **One Computer Use approvals sitting** (~30 min at your Mac, agent driving).
      You click Approve on the real banner about five times and change one operator-only setting
      twice. Each grant has a **60-second decision window**, which is why this has to be a sitting
      rather than something an agent asks for while you are elsewhere.
      → Unblocks `computer-use-autonomy-level` (4 checks), `session-scoped-computer-use-autonomy`
      (1) and `computer-use-consent-and-targeting` (1). `browser-harness-group-lifecycle` (4) needs
      a separate Chrome grant on `windows-pc`, not this sitting.
      An agent approving its own grant would defeat the exact self-control guard these checks
      verify, so it cannot be scripted around. Two grants requested on 2026-08-30 reached genuine
      pending state and expired unactioned.

      Order, because check 4 quits the app and the setting gates the rest:
      1. **Agent, before you sit:** rebuild and restart Harness from this checkout — the installed
         app predates the change.
      2. **You:** set Computer Use autonomy to **Trusted** in Settings. `computerUseAutonomyLevel`
         is operator-only even through the privileged CLI
         (`settings-control-policy.ts:97`), so no agent can set it.
      3. Approve a **TextEdit** grant → checks 3 (Space/Enter reach the app) and 6 (a high-entropy
         string types, and the audit row shows `[redacted]`).
      4. Check 4 first half: Cmd-Q is refused at Trusted. **You:** switch to **Unrestricted**;
         repeat and TextEdit really quits. Do this last, it closes the app.
      5. Approve a **Terminal** grant, then a **System Settings** grant → check 2. The System
         Settings one also matters for the clean-TCC job below.
      6. Approve a grant on a safe disposable app → `session-scoped` check 3, a slow observation
         while you flip the session control back to Global mid-flight.
      7. Optional, lowest odds: `consent-and-targeting` check 4 also needs an allowlisted harmless
         in-window control. Activity Monitor was tried at a 2,000-node snapshot and had none, so
         ask the agent to find a candidate app *before* you spend an approval on it.

- [ ] **Approve one bounded Chrome observation grant on `windows-pc`** (~5 min of yours).
      → `browser-harness-group-lifecycle`, 4 checks — the only document of the four that has still
      never had a live grant attempt of any kind.
      An agent must reload the unpacked Harness extension from this checkout first, and can
      pre-stage check 4's duplicate group chips. All four checks read the Chrome **tab strip**, not
      page content, so they need a cropped window capture rather than the extension's own view.

- [ ] **One clean-TCC window** (~20 min, Harness stopped).
      `tccutil reset ScreenCapture` / `Accessibility` is enough — **a fresh macOS user account is
      not required**, contrary to the previous version of this file. Then grant Accessibility and
      Screen Recording at the prompts.
      → Closes `computer-use-permission-onboarding` (3 checks) and the last check of
      `local-macos-computer-use-signing`. One clean run satisfies both.
      No Apple Developer credentials needed: the signing steps are already closed and used the
      identity already in your keychain. The real obstacle is that the reset strips grants from the
      packaged Harness you are actively using, so it needs a quiet window.

- [ ] **One real Report MI login with OTP** (~15 min). `browser-gateway-credential-login`, 2 checks.
      → **This item has shrunk.** The vault unlock is no longer yours: `browserVaultAutoUnlock`,
      `browserVaultMasterPasswordFile` and `browserAllowSharedTabCredentialFill` became writable
      through the privileged CLI on 2026-08-29 (`settings-control-policy.ts:52-64`, `:387-392`), so
      an agent can unlock and enable hands-free fill itself.
      What is left is the real cross-domain login at `auth.reportmi.gca.gov.uk`. Enrolment is
      human-initiated-only by design, and the doc carries an explicit boundary that no agent
      performs a real login to a real service.

- [ ] **Two Copilot OAuth sign-ins** (~15 min). One personal, one work/enterprise, each a real
      browser OAuth on an entitled seat.
      → Unblocks checks 1–9 of `copilot-account-routing` (11 open). Checks 10 and 11 are pure
      renderer geometry and are agent work — no need to wait for you.
      A signed-in disposable Copilot profile also unblocks the single check in
      `acp-long-tool-timeout`, which additionally needs a quiet 10–60 minute window. Copilot is
      excluded from automation by `providersExcludedFromAutomation`, so the sign-in has to be yours.

- [ ] **One iPhone session** (~30 min). Paired device plus Xcode.
      → Closes 9 of the 10 checks in `mobile-queue-interrupt-draft`: Capacitor haptics, native
      dialogs and on-device rendering have no CDP or web equivalent. Also the mobile-badge half of
      `sibling-audit-round2` C2. Check 9 needs the phone **and** a decision (see 7 below): its
      red-row styling and `Couldn't send:` text are on-device rendering like the rest.

- [ ] **Enter one disposable secret and handle the native keychain prompt** (~10 min, needs a
      rebuilt app with an available macOS keychain and a real provider session).
      → `workspace-secret-card`, 4 open checks: the card rendering, native keychain persistence, the
      agent reference round-trip, and authorised local MCP-connector materialisation.
      The **feature is built** (see the cleared section), so this is live validation, not
      implementation. Use an obviously fake value.

- [ ] **Five minutes with VoiceOver on.** `loop-issue-diagnosis-ux` LT-3: confirm the diagnosis card
      announces once and does not re-announce on disclosure or focus changes.
      → No agent tool captures VoiceOver's spoken output. LT-1 and LT-2 are agent work.

- [ ] **A quiet window to install and restart the signed candidate build.**
      `Harness.secure-credential-gate19.app` is staged and waiting; the secure-remote-credential
      plan cannot close until it is installed, restarted and re-smoked.

---

## 🔴 Historical release prerequisites — not current CI/release state

- [ ] **7 GitHub Actions signing secrets, a version bump, and a pushed `vX.Y.Z` tag.**
      → Blocks all 9 checks of `harness-auto-update`. Nothing narrows it without you.
      Re-verified today on `Community-Tech-UK/ai-orchestrator`: **0 repository secrets, 0
      environments, 0 tags, `release.yml` has never fired, version still `0.1.0`.**
      The five Apple secrets need an active Apple Developer account and an App Store Connect API
      key tied to your identity and 2FA. The two Windows ones need a purchased code-signing
      certificate with org identity verification. No agent can self-provision any of them.

- [ ] **4 secrets for `mytrademail`, separately.** `SENTRY_DSN`, `MTM_SENTRY_DSN`, `SBE_SENTRY_DSN`
      and `FCM_SERVICE_ACCOUNT_KEY_PATH` in that repo's `production` environment, which needs Sentry
      projects and a Firebase service-account key.
      → This is the only thing holding `github-actions-remediation` open. Different repo, different
      job from the item above. Tasks 1 and 2 are done and green in CI.

---

## 🟣 Historical requests for authority and disposable resources

- [ ] **A disposable worker node, or authority to disrupt `windows-pc`.**
      → `local-ai-guard` checks 2 and 5 need a worker that can be stopped mid-check.
      `local-ai-guard-cli` checks 2 and 3 need authority to run a live `enrol` that rewires 11 real
      auxiliary-LLM routing roles in your live app. That is 4 checks across 2 documents; the
      previous version of this file counted only 2.

- [ ] **A disposable throwaway SPA account** whose network can be cut mid-form.
      → `browser-gateway-reliability` check 4. Every prior attempt correctly refused to run a
      destructive network cut against your real authenticated session.

- [ ] **Name an EBRD scratch repo** an agent may edit under `/Users/suas/work/ebrd`.
      → `cross-model-checking-policy` LT-A to LT-F. Everything found there is a real
      client/Azure DevOps repo, and an agent should not pick one unilaterally. This is the only
      James item in that document; the `lawrencj` Copilot seat is already configured.

- [ ] **One approval click for a real push and PR.** `sibling-audit-round2` B1 Gate 2 raises a
      native OS dialog that CDP cannot click, for a genuinely consequential action.

---

## 🔵 Historical decision menu — do not answer as a current request

1. **Opt-in debug port on the packaged app?** Called the highest-leverage unblock across four
   consecutive reports and still undecided. **Correction: it now unblocks 1 document, not 3.**
   `hidden-automations` closed on 2026-08-24 without it, using a separate dev app with CDP in an
   isolated profile; `fable-ws13` no longer cites it anywhere. What remains is
   `worker-controller-file-movement` (4 checks), which genuinely needs to observe the live packaged
   app's own renderer — a hard-denied Computer Use target with no debug port.

2. **Compact the historical browser-audit rows?** Measured read-only today:
   `browser_audit_entries` holds **~3.48 million rows and about 1.29 GB, roughly 29% of a 4.48 GB
   `rlm.db`**.
   Ongoing growth is fixed and 90-day pruning is live and scheduled, but pruning only issues
   `DELETE`s and `auto_vacuum` is `NONE`, so the space is not returned on its own. A reclaim path
   does exist — RLM storage maintenance calls `VACUUM` (`src/main/rlm/rlm-storage-maintenance.ts:212`)
   — so the question is whether to run a deliberate compaction of the historical rows, not whether
   a mechanism exists. Needs the app stopped; irreversible.

3. **LT-196, the correction miner.** The original handoff described it as dead for Claude after
   LT-062 stopped writing `tool_result` messages and requested authority to write a spec. That
   request is superseded by the completed plan/spec linked above, not still awaiting an answer.

4. **LT-481, Workboard snooze.** Broaden the mechanism to be baseline-aware, or remove it. It
   currently self-un-snoozes on an already-blocked card.

5. **Skill-matching threshold.** Lower the global `0.65` in
   `src/main/memory/skills-loader.ts:53`, add per-skill
   thresholds, rewrite skill descriptions as prose, or wire a real embedding provider. All 36-skill
   measurement data is already gathered; no more testing will resolve it.

6. **Spend billed provider tokens** on enhancements-backlog livetest checks 20 and 21 (continuation-card vs reanchor constitution, and recycle 0.85 vs 0.6)?

7. **Mobile check 9.** Add a timing hook to `dispatchSend()`/`deliverNext()`, or accept the
   existing 30/30 unit evidence.

8. **`browser-gateway-reliability` check 3.** Does split evidence from two separate natural
   disconnects satisfy it, or does it need one clean run?

9. **Was the unexplained Local AI enrolment deliberate?** `733d66c0-…`, created 2026-08-24 20:44
   UTC, 12 routing roles on `windows-pc`. No evidence run created it and the app log had rotated
   past its creation.

10. **LT-029, hardened mode and keychain writes.** Credential refresh writes to
    `~/Library/Keychains`, which is in none of the writable roots. Grant the root, or record the
    limitation as a deliberate security trade-off.

11. **Six documents carry a `Recommended for deletion` section.** Each needs a yes/no rather than a
    test run. The clearest case is the non-resident-Claude half of check 3 in
    `provider-agnostic-context-evidence`: the architecture no longer permits reaching that state.

12. **Historical request to delete ~16 GB of stale `_scratch/` database snapshots** — an 11 GB
    `pre-migration-…/rlm.db` and 5.2 GB of `dedupe-verify/*.db`. The later record above says the
    deletion was performed; these old paths are not a current cleanup target list.

---

## Items described as cleared in the September 6 handoff

- ✅ **Reload the Chrome extension on `windows-pc`.** Done. Verified live today: extension
  **v0.2.19, reloaded 11:05 BST**, last contact seconds ago, relay registration `ok`, browser
  automation running, worker up 6.5 h.
- ✅ **Leave Chrome running for 15 minutes.** Done. `remote-node-false-negative-fixes` closed with
  all 7 checks passing and is now `_livetest_completed`.
- ✅ **Check the Copilot quota chip after a working day.** Done.
  `automation-provider-exclusions` closed with all 6 checks passing.
- ✅ **The Workspace Secret Card *decision*, "do you still want Phases 2 and 3?"** — **they are
  built**, so there is nothing to decide. Re-verified against today's source, not against the
  plan's own claims: migration `062`, the workspace MCP connector registry,
  `WorkspaceSecretStore.resolve()`, `secret://` support in `browser.fill_secret`, the renderer card
  (wired into the routed `user-action-request` component) and the Security-page management panel
  all exist, committed 2026-09-02 in `ca09eeefb`, with the scoped suites passing. The 2026-08-26
  audit that said none of it existed was correct on the day and is now obsolete.
  **But the document is not closed:** 4 live-validation checks remain and they do need you, which
  is why the sit-down list above now carries a disposable-secret item.
- ✅ **A deliberate link cut on `windows-pc`.** Superseded 2026-08-25 by a self-contained
  disposable-worker harness (isolated dev app plus a from-source worker-agent, both on loopback).
  `fable-ws15` checks 2/3/5 are agent-runnable with no dependency on your node.
- ✅ **The vault-unlock half of the Report MI item.** Agent-reachable since the 2026-08-29 policy
  widening.
- ✅ **CI red from the Copilot adapter.** Fixed 2026-08-27 in `bdf4ad89a` — the blocking
  `gh copilot --help` probe moved out of the constructor into a lazy `ensureLaunchResolved()`.
  Both adapter specs now run in 881 ms against a 5,000 ms timeout.
- ⚠️ **Local Mac browser/UI control, authorised 2026-08-26 — correction.** The grant is real and
  standing, but the previous claim that it cleared four documents was too strong. It does not
  extend to approving a Computer Use grant, which is what the approvals sitting above is about.
  Where the four documents actually stand: `computer-use-consent-and-targeting` was genuinely
  retried on 2026-08-30 and hit that approval wall; `browser-harness-group-lifecycle` has still
  never had a live grant attempt at all; `browser-permission-ux` and `local-shared-browser-control`
  carry post-authorisation notes saying the block is gone but no live run against them.
  Still off-limits regardless: Harness itself, terminals, password managers, Keychain, System
  Settings security panes and provider apps.
- ✅ Poisoned git index (2026-08-20), CI allowlist fix `fc90e707`, LT-216 tab attachment, and Ollama
  health on `windows-pc` — all long since settled, dropped from this list.

---

## Other observations recorded September 6 — not present-tense status

- **Historical CI-red observation.** The handoff's last green run was 2026-09-01T02:13. It reported later runs as red or
  cancelled, most recently 2026-09-06T10:32Z on `rlm-process-ownership.spec.ts` and
  `loop-coordinator-memory.spec.ts`. Both pass locally in isolation, so it looks like a
  sharding/order-dependent flake, but that is unproven. It is a different failure from the
  2026-08-25/26 one, nobody has triaged it, and it has no `LT-NNN` entry.
- **Historical LT-526 concern, now superseded:** the handoff described the August 31 code fix as
  not yet confirmed against a running app and prioritized `fable-ws13` check 5. The owning record
  linked above subsequently documented that live verification; this is not a current open claim.
- **Two documents may be over-gated.** `history-preview-model-selection` gates all 6 of its checks
  behind you re-verifying a Browser Gateway audit, but the checks are renderer and model-picker
  behaviours with no browser-page involvement — the prerequisite looks copied from a template. And
  `sibling-audit-round2` B3 is filed as blocked on an unreachable auxiliary-LLM endpoint, which
  `windows-pc` may now satisfy. An agent should retry both before either lands on your list.
- **`token-efficiency-remediation`** has 9 open checks, needs no rebuild and no authority from you.
  It is the closest document in the set to being closed by an agent.
