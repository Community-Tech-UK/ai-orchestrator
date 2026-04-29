# Doctor, Updates, And Artifacts Runbook

Use Doctor when startup, provider, command, instruction, browser automation, CLI update, or support artifact state needs one place to inspect.

## Deep Links

Startup degradation banners open Settings with `tab=doctor` and a section query parameter. Use the active section in the left rail to confirm the banner routed to the expected diagnostic group.

## Sections

- Startup Capabilities: native modules, provider readiness, and subsystem probes.
- Provider Health: per-provider probes and recommendations.
- CLI Health: detected installs and supported update plans.
- Browser Automation: bundled runtime, node runtime, in-app connectivity, and tool count.
- Commands & Skills: markdown command diagnostics and skill file diagnostics.
- Instructions: project instruction conflicts and broad-root warnings.
- Operator Artifacts: local support bundle export and reveal actions.

## CLI Update Pill

The title-bar pill shows when supported CLI update plans are available. Click it to open Doctor's CLI Health section, then inspect the displayed update command before running anything outside the app.

## Artifact Bundle

Export Bundle writes a local zip under app user data. Bundles include Doctor reports, CLI health, browser automation health, command diagnostics when available, instruction/skill diagnostics, lifecycle tail, and optional selected-session diagnostics.

## Redaction Policy

Bundles are local and redacted before writing. Home paths are converted to `~/...`; secret environment values are replaced with `<redacted-secret>` or presence-only env metadata; selected session bodies are omitted.
