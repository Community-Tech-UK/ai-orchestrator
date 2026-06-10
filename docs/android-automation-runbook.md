# Android Automation — Operator Runbook

How to enable Android testing on a remote worker node so agents spawned there get
`mobile-mcp` tools locked to one leased emulator or physical device.

## Security — read first

Android automation can install apps, launch activities, tap UI, read screen
state, and collect screenshots/logs on the leased device.

- Enable only on trusted, owned worker nodes.
- Use dedicated emulator images for automation when possible.
- Keep physical devices authorized only while needed.
- Do not store app credentials, adb keys, keystores, or test account secrets in
  repo files or screenshots.

## Worker prerequisites

Install on the worker machine:

1. Node.js 22+.
2. Android SDK Platform Tools (`adb`) and Emulator.
3. At least one AVD if emulator automation is needed.
4. Optional: Maestro CLI if you want Maestro exposed to agents.

Verify locally on the worker:

```bash
adb version
adb devices -l
emulator -list-avds
maestro --version
```

## Enable from the app

Open **Settings > Remote Nodes > Connected Computers**.

Android badges mean:

- **Ready** — Android automation is enabled and an online device/emulator is
  currently visible.
- **Enabled (starts emulator on first use)** — enabled, but no device is online;
  the worker can boot the configured AVD when a spawn requires Android.
- **SDK detected** — ADB is present, but automation is not enabled.
- **Off** — no SDK/ADB state was reported.

Click **Configure Android automation**, enable it, set SDK path/AVD if needed,
and apply. The coordinator sends a service-scoped `config.update`; the worker
persists the block, reconfigures its emulator manager, and re-reports
capabilities on the next heartbeat.

## Manual config alternative

Edit the worker config (`~/.orchestrator/worker-node.json` or service config):

```jsonc
{
  "androidAutomation": {
    "enabled": true,
    "sdkPath": "C:\\Users\\YourName\\AppData\\Local\\Android\\Sdk",
    "defaultAvd": "Pixel_8_API_35",
    "headlessEmulator": true,
    "maxEmulators": 1,
    "bootTimeoutMs": 180000,
    "allowPhysicalDevices": true,
    "injectMaestroMcp": false
  }
}
```

Restart the worker after manual edits.

## Routing and leases

When a spawn carries `nodePlacement.requiresAndroid`, the worker:

1. Selects an online physical device if allowed/requested, otherwise boots or
   reuses the configured emulator.
2. Records a lease for the instance so no other local instance receives the same
   serial.
3. Injects `mobile-mcp` pinned to `@mobilenext/mobile-mcp@0.0.59`.
4. Sets `ANDROID_SERIAL` and appends an Android lease section to the system
   prompt.
5. Releases the lease on exit, terminate, or spawn failure.

The agent must pass the exact leased serial as the `device` parameter to every
mobile-mcp tool call and must not touch other serials.

## Smoke test

Ask from a channel or orchestrator prompt:

```text
Use Android automation to screenshot the home screen on the leased emulator.
```

Expected behavior:

- The task routes to an Android-capable worker when auto-offload is enabled.
- The worker boots the default AVD if no device is online.
- The agent receives mobile-mcp tools plus an Android lease prompt naming the
  serial.
- The resulting report includes the serial and a screenshot artifact/path.

## Troubleshooting

- **Badge says off** — set `ANDROID_HOME`/`ANDROID_SDK_ROOT` or configure
  `sdkPath`; restart or apply config from Settings.
- **No AVDs** — create one in Android Studio Device Manager or with
  `avdmanager`, then run `emulator -list-avds`.
- **Physical device missing** — enable USB debugging, approve the computer, and
  confirm `adb devices -l` shows `device` rather than `unauthorized`.
- **Spawn has no mobile tools** — ensure the node reports `hasAndroidMcp: true`
  and the task requested Android placement (`requiresAndroid` or Android
  auto-offload intent).
- **Emulator hangs during boot** — the worker retries once with
  `-no-snapshot-load` to bypass a corrupted Quick Boot snapshot. If it keeps
  failing, wipe or recreate the AVD from Android Studio Device Manager.
- **First mobile-mcp spawn is slow** — the MCP server is fetched via `npx` on
  first use and cached. Pre-warm with:
  `npx -y @mobilenext/mobile-mcp@0.0.59 --help`.
