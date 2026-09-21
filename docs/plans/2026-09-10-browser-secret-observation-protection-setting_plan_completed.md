# Browser secret observation protection setting

Status: completed 2026-09-10. Remaining live checks are in
[2026-09-10-browser-secret-observation-protection-setting_livetest.md](2026-09-10-browser-secret-observation-protection-setting_livetest.md).

## Goal

Give James a durable, operator-only way to turn off the post-fill secret-observation lock on shared Chrome tabs (local and `windows-pc`). Vault binding, origin authorisation, and `fill_credential` itself stay unchanged. Default stays ON so current taint + popup-reset behaviour is preserved until he flips it.

## Why

After a credential fill the extension taints the origin/tab. Snapshot, query, click, and download then fail until James resets protection in the toolbar popup with Browser Gateway off. That blocks Diamond DLSITT1105 pack download on `windows-pc`. Reset is slow, and the next fill re-taints.

The completed recovery plan (`2026-09-05-browser-secret-observation-recovery_plan_completed.md`) explicitly has no browser-tool reset and no automatic declassification. This plan adds a Settings toggle only.

## Behaviour

1. New setting `browserSecretObservationProtectionEnabled`, default `true`.
   - Writable in Settings (Advanced generic row).
   - Closed to `set_setting` / `reset_setting` MCP tools (`readOnly`).
   - Closed to the privileged `$AIO_MCP settings` CLI (operator-only anchor). James-only.
2. When OFF:
   - Credential / secret fills must not taint origin or tab.
   - Applying OFF clears existing taint flags for that browser profile the same way popup reset does (flags only; no cookies, passwords, or site data).
   - Snapshot / query / click / download / navigate work after fill.
   - Popup shows that protection is disabled by the Harness setting, and does not pretend the origin is still protected.
3. When ON: current taint + popup reset path is unchanged.
4. Applies to shared extension tabs on local and remote nodes. Extension bumped from 0.2.19 and deployed/reloaded on `windows-pc`.
5. Do not weaken vault binding, origin authorisation, or fill itself.

## Implementation

### App setting

- `AppSettings` + `DEFAULT_SETTINGS` (`true`) + metadata on Advanced (`settings-metadata-runtime.ts`).
- `SETTINGS_TOOL_POLICY`: `readOnly()`.
- `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`: add the key (21st anchor). Update the pinned count and both CLI docs.
- `settings-surfacing`: `'tab'`.
- `settings-export`: machine-local (fail closed on import; default ON).
- Renderer: generic Advanced row via `SETTING_METADATA` (`!hidden`, category `advanced`). No bespoke control.

### Coordinator → extension

Taint lives in the extension. The coordinator setting must travel with commands (the Windows native host cannot read Mac settings).

- Stamp `secretObservationProtectionEnabled` on every shared-tab command payload, overwriting any caller-supplied value (agents cannot smuggle `false`).
- Fail closed to ON if settings cannot be read.
- On `setting-changed` for this key, enqueue `report_inventory` on every active extension queue so existing taints clear without waiting for the next fill.
- Do **not** apply on gateway bind/startup (a useless `report_inventory` would time out every launch). The first shared-tab command after restart carries the stamped flag; a stored-OFF value in extension storage also skips taint until that command arrives.

### Extension (0.2.20)

- Persist the flag in `chrome.storage.local`. Missing key = ON.
- Apply the payload flag before observation guards and before `markSecretTaint`.
- When OFF: skip taint, skip observation block, skip write-time preclassification, skip lineage inheritance; clear stored taint flags (same persist-first pattern as popup reset).
- `get_secret_protection` reports `protectionEnabled`. When OFF: empty origins/tabCount, no review token.
- Popup: when `protectionEnabled === false`, show that Harness Settings disabled protection. Hide reset/review controls. Do not list origins as protected.

### Tests

- Setting OFF: fill / `markSecretTaint` does not persist taint; observation commands are allowed; applying OFF clears existing flags only.
- Setting ON: current taint behaviour still holds.
- Agents cannot flip the setting (safe MCP + privileged CLI).
- Popup copy matches the disabled-by-setting state.
- Version/hash append-only row for 0.2.20.

## Out of scope

- Changing vault folder jail, origin-bound fill, standing authorisations, or shared-tab fill opt-in.
- A browser-tool reset while the setting is ON.
- Automatic declassification when the setting is ON.

## Live checks

Rebuilt/restarted Harness is required for the Settings row and the coordinator stamp. Extension deploy/reload on `windows-pc` is required for the new bundle. James must turn the setting OFF in Settings (agents cannot). The Diamond fill → snapshot → download check is recorded in the livetest doc.

## Acceptance

- [x] Setting exists, default ON, Advanced row, search-catalog membership.
- [x] MCP `set_setting` / `reset_setting` refuse it.
- [x] Privileged CLI refuses it.
- [x] OFF: no taint after fill; existing taints cleared on apply; popup disabled copy.
- [x] ON: taint + popup reset unchanged.
- [x] Extension 0.2.20 shipped; hash recorded (`62c869613df1` prefix in assets history).
- [x] Focused tests pass. lint, `build:main`, `build:renderer` green. Independent re-run of `tsc` / spec `tsc` / `check:ts-max-loc` also green on the feature tree.
- [x] Independent task-completion-gate PASS (follow-up confirmed the 0.2.20 hash prefix).
- [x] 0.2.20 files copied onto the `windows-pc` unpacked checkout. Reload + Diamond path recorded in the livetest doc.
