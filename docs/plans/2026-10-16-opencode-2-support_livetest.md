# OpenCode 2 support: live checks

Status: Pending. These checks require a rebuilt/restarted Harness, a signed-in model provider, or the external Windows worker. Implementation verification and the fifth independent completion review have passed. These live observations are still unverified; automated and isolated runtime evidence is recorded in the completed implementation plan.

Implementation plan: [OpenCode 2 support](2026-10-16-opencode-2-support_plan_completed.md).

## Prerequisites and remediation

- Use a rebuilt and restarted Harness containing this implementation; do not infer behavior from the already-running app. The restart also invalidates the temporary session credential exposed in the diagnostic incident recorded in the implementation plan. No restart or credential invalidation has yet been verified.
- Read [the campaign runbook](livetest-campaign-runbook.md) before a campaign. Record reproduced defects in [the remediation register](livetest-remediation-register.md) with a matching implementation-status entry in [the remediation plan](2026-07-19-livetest-failure-remediation-followup_plan.md). Keep per-check evidence here.
- Browser/UI work must preflight the Browser Gateway and target `windows-pc`. Never control the Mac browser/desktop without James's permission for this task. The Harness desktop app is a hard-denied Computer Use target; James must perform those desktop actions himself.
- Use only names and safe summaries in evidence. Never include account keys, credentials, raw auth exports, private prompts or credential-filled screenshots.

## 1. Account selection, repair and shared database

- [ ] In the rebuilt Harness, select OpenCode and sign in to a second MiMo account with the desired region. Existing legacy-key repair must list provider names and require an explicit `yes` before copying that selected key; entering a replacement key must hide it. Cancel must not copy anything.
- [ ] Open a session in `~/work/communitytech` with that second account, then a session with the original account. Confirm each session reports its selected account/model and can complete a harmless prompt. Confirm the desktop app's existing sessions/keys remain present in the shared database.
- [ ] With only an older OpenCode 2 install, starting a session must ask for an update to at least 2.0.30 and refuse it. With a supported 2.x alongside 1.x, startup must select 2.x; when 2.x cannot read config but 1.x can, it must fall back to 1.x.

Expected: no account silently borrows another key; account repair is explicit; model metadata and the chosen region agree. Why deferred: authenticated provider access and a restarted desktop app are required. Isolated placeholder-key import, read-only identity lookup and model metadata are covered in-loop.

## 2. Authenticated reply, usage, delegation and continuation

- [ ] Run a harmless prompt on an authenticated `opencode/*` model and record a sanitized actual response fixture for prompt usage, cumulative cost and final stop reason. Disposable-home attempts against the advertised MiMo and Cat Jam free models returned `auth_required`; no real account was used for those probes.
- [ ] Run a sub-agent-heavy task. Child progress must keep the parent active through a long tool call; child text/usage must not duplicate into the parent answer/token totals. Retry notices must be visible, clear on terminal error/completion and avoid leaking provider messages.
- [ ] Trigger compaction through the session's advertised `compact` command and, if practical, automatic compaction. Harness must show the pause as compaction and then continue.
- [ ] On MiMo, request a sufficiently long response to exercise output-limit continuation. The reply must continue without a false truncation warning; a genuinely stopped `max_tokens` turn must remain distinguishable. Confirm the combined reply/reasoning cap still respects both Harness and OpenCode limits.
- [ ] Have the model ask a multiple-choice question and a text question. Both must appear in Harness's normal question controls, including with automatic tool approval enabled; submitting must resume the same turn. Skip must cancel the form.

Expected: real provider observations match the bounded protocol/unit fixtures, with no silent hangs or duplicate accounting. Why deferred: the advertised free backends require authentication, and provider-driven delegation/compaction/output saturation require an external inference service. Local protocol fixtures, actual OpenCode 2 against a scripted localhost model (including child metadata and automatic output-limit continuation), and isolated real session creation/load/resume/fork are verified in-loop. Authenticated MiMo behavior remains to be checked.

## 3. Resume, fork, tools and command menus in the restarted app

- [ ] Recover a session for which Harness retained the complete transcript. Verify native `session/resume` is used without replay duplicates. A session without complete retained history must use `session/load`.
- [ ] Fork a supported OpenCode 2 session. The fork must have its own session identity and preserve the original. Verify supplied extra folders appear in the ACP request as absolute `additionalDirectories`.
- [ ] Confirm intended Harness MCP tools arrive on the session request and can be called; they must use stdio or HTTP. Verify advertised slash commands update for the selected session and a stale command from another session cannot execute.

Expected: recovered messages remain complete, forks are separate, and commands/tools belong to the selected session. Why deferred: visible desktop integration requires the rebuilt/restarted app. The executing adapter and IPC paths have automated coverage.

## 4. Windows worker and install/update confirmation

- [ ] After normal worker deployment and restart, check its capability report contains the selected OpenCode major. A 1.x or unknown worker must reject a 2-only fork/extra-folder operation before work is sent.
- [ ] On `windows-pc`, verify 2.0.30+ starts through the native executable or npm launcher, including a path with spaces. Confirm helper commands use `--standalone`, account import sends JSON only on stdin, and no shared service is started or joined (the service's port is irrelevant to this private process path).
- [ ] In provider checkup, review the proposed `npm install -g @opencode/cli@2` command. The offer must explain that it replaces the OpenCode 1 command and show the pinned `opencode-ai@1` fallback. Do not run an install until James confirms that major-version change.
- [ ] Check an actual 1.x update and 2.x update when one is available. Each must compare with its own npm package. Version 1 uses `opencode upgrade` without `--major`; version 2 must pin a verified stable 2.x target and refuse unknown/different-major targets. Homebrew 2.x must direct a deliberate manual update because its native updater ignores version targets. App-managed binaries must direct updates through the desktop app.

Expected: Windows behavior matches the local protocol tests, installer actions remain explicit, and unattended checks never propose a cross-major update. Why deferred: worker deployment/restart and real installation changes require external runtime access/authority. Windows command selection, quoting and major filtering are tested in-loop; the disposable 1.19.1 upgrade attempt timed out, while inspection of its executing bundled code confirmed the separate `--major` guard.

## 5. Windows native permission action comparison

- [ ] Use the supported native Windows executable with all HOME/USERPROFILE, APPDATA/LOCALAPPDATA, XDG directories and explicit OPENCODE_DB pointing to a disposable temporary tree. Remove inherited OPENCODE_* overrides and disable model fetching. Do not use James’s normal database, configured service, provider credentials, model prompts or actual tools.
- [ ] For each action pattern `shell*`, `Shell*`, `SHELL*`, `s?ell`, `subagent*`, `SUBAGENT*`, call `api --standalone POST /api/session --data <JSON>` with `{location:{directory:<temporary-project>},permissions:[{action:"*",resource:"*",effect:"deny"},{action:<pattern>,resource:"*",effect:"allow"}]}`. Pass JSON as an exact native-process argument array. Read the returned `data.id`.
- [ ] Call `api --standalone POST /api/session/<id>/permission --data <JSON>` with `{action:"shell",resources:["harmless-placeholder"]}` (use `subagent` for the two subagent patterns). Record native version, each exit code and effect only.
- [ ] Compare the actual Windows effects with the post-overlay Harness assertion. Native matching must use the native shell/subagent namespace. In particular, a mixed-case ask rule must not falsely prove protection if the native evaluator ignores it, and a matching allow must be refused. Record any discrepancy through the remediation flow above.

Expected: lower-case wildcard overrides are rejected by Harness; action case handling agrees with the actual Windows native evaluator. Why deferred: the registered Windows worker was connected. Two initial requests were rejected by the remote task tool’s shared-browser wording detector. A clarified terminal-only request subsequently ran through the supported default provider; its agent reported only OpenCode 1.19.0/1.18.35 and no opencode2, then stopped without installing or running the cases. The returned stream contained the report but no raw command output, so those versions remain attributed agent observations. Native OpenCode 2 on Windows was not proven available and no native case effect was observed. The finished remote agent was terminated to free capacity. Native macOS wildcard and case behavior was observed in-loop; Windows behavior is not inferred from that result.
