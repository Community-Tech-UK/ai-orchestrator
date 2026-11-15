# Home-base checks on the Windows PC

This monitor is prepared for plan step 1.6. It is not installed or paired by a build.
The home base must first run the new automation list projection, and James must choose a working PC mail route
and whether the monitor uses a separate standard Windows account. No sender is assumed or configured here.

## Install and pair

Run `install-monitor.ps1` in the Windows account that will own the monitor. It copies the two JavaScript files to
`%LOCALAPPDATA%\Harness\home-base-monitor`, outside the checkout, and restricts that folder and its files to
the owning account and SYSTEM. Node must be installed on Windows. `-WhatIf` previews changes; no task runs yet.

Create `monitor.json` in that private folder with these fields, replacing the placeholders there:

```json
{
  "gatewayUrl": "http://<home-base-Tailscale-IP>:4889",
  "peer": { "host": "<a-different-computer-Tailscale-IP>", "port": 22 },
  "notificationCommand": {
    "executable": "<full-path-to-confirmed-mail-program>",
    "args": ["<arguments-for-the-existing-mail-route>"]
  }
}
```

Use literal Tailscale IPv4 or IPv6 addresses (put IPv6 in brackets in the URL). The gateway URL must contain no
username, password, path, query or fragment. Choose a port that really answers on a different Tailscale computer
for the independent probe. Prove both connections from Windows before enabling the task. The mail command must
already work on that account. Keep credentials in its own private files or credential store, never command arguments.

The notification command receives one JSON object on stdin, `{id, subject, text}`. It must exit zero only after
accepting the email, and deduplicate repeated `id` values, including after its own restart. It must not print
credentials. The monitor never prints that command's stdout or stderr. Failure leaves the alert queued.
Until a confirmed route and its adapter are configured and tested, email delivery remains a rollout blocker.

Make an owner-level phone pairing code on the home base, then use PowerShell's secure prompt to pass it to
`monitor.js pair --config <private-monitor.json>`. The code goes through stdin, never a command argument:

```powershell
$folder = Join-Path $env:LOCALAPPDATA 'Harness\home-base-monitor'
$code = Read-Host 'Home-base pairing code' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($code)
try {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) |
    & node (Join-Path $folder 'monitor.js') pair --config (Join-Path $folder 'monitor.json')
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  Remove-Variable code, pointer
}
```

The resulting `device-token.json` is private and outside the checkout. It grants owner-level access and can be
revoked from the home base. All agent sessions under the same Windows account can read it; use James's decision
about a separate account before installing it. Never copy a token into a plan, test, log or chat.

Run one `check --config <private-monitor.json>` manually, inspect its state and prove a real email through the
chosen sender. Then run `install-monitor.ps1 -Enable`. The task repeats every 15 minutes, prevents overlap,
and has a two-minute run limit. Its account must remain signed in. To stop it, disable the
`HarnessHomeBaseMonitor-<account SID>` task in Windows Task Scheduler; to revoke access, remove its pairing on the home base.

## What is checked

- Only an authenticated `/api/automations` response counts as reachable. Refused/expired tokens, an invalid response
  and hosts without the new projection count as failed checks. HTTP redirects are refused, so the token stays with
  the configured endpoint.
- After 30 minutes of failed checks, one alert states which connections the PC could not make, including the separate
  peer probe. It does not diagnose the home base as down. One recovery email follows a previously reported outage.
- A job becoming disabled, a failed or skipped last run, a paused run, `needs_attention`, a run past its saved deadline,
  or a next appointment at least 30 minutes late generates an alert. A job disabled at the first check is left alone.
- Repeated observations of one condition do not create more alerts. A later failed run creates a new alert.
  `monitor-state.json` stores an outbox before delivery. The sender must honor the alert's id to avoid duplicate email
  if the process stops after sending but before saving its acknowledgement. One queued message is sent per check.

The list currently caps at 100 jobs. A response at that cap is refused because it cannot prove the list is complete;
add pagination before enrolling 100 jobs. The monitor is silent while the PC is asleep, restarting, or its account
is signed out. It cannot report its own computer being unavailable. Scheduled-task installation, the private-folder
permissions and real mail delivery need live Windows verification before rollout.
