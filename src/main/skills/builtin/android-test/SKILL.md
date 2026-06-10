---
name: android-test
trigger: /android-test
description: Test an Android app on a leased worker emulator or physical device using mobile-mcp and adb evidence
parameters:
  - name: app
    required: false
  - name: flow
    required: true
  - name: device
    required: false
---

# Android Test Skill

Use when the user asks to install, launch, inspect, screenshot, or test an Android app.

## Workflow
1. Confirm the Android device lease section in the prompt and copy the exact serial.
2. Use mobile-mcp tools with that serial as the `device` parameter on every call.
3. If an APK path is provided, install it on the leased serial only.
4. Launch the app and capture a starting screenshot.
5. Execute the requested flow with mobile-mcp. Use adb only for evidence or diagnostics that mobile-mcp cannot provide.
6. Return a concise report with device serial, app/package, steps run, screenshots/log snippets, pass/fail, and blockers.

## Rules
- Do not touch Android serials other than the leased serial.
- Prefer accessibility tree selectors over coordinate taps when available.
- Capture screenshots before and after risky navigation.
- If the device is offline, unauthorized, or missing, stop and report the state instead of retrying unrelated serials.
