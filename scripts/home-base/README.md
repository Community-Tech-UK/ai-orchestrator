# Home-base checks on the Windows PC

This monitor is for plan step 1.6. It runs under the separate standard `HarnessMonitor` Windows account and
sends to James's Community Tech inbox through Microsoft 365. The home base must run a build with the current
automation list projection, and the monitor needs its own pairing. A build does not install or pair the monitor.

## Install and pair

Run `install-monitor.ps1` in the Windows account that will own the monitor. It copies the monitor and sender to
`%LOCALAPPDATA%\Harness\home-base-monitor`, outside the checkout, and restricts that folder and its files to
the owning account and SYSTEM. Use the installed Windows Node 24 runtime. `-WhatIf` previews changes; no task runs yet.

Create `monitor.json` in that private folder with these fields, replacing the placeholders there:

```json
{
  "gatewayUrl": "http://<home-base-Tailscale-IP>:4889",
  "peer": { "host": "<a-different-computer-Tailscale-IP>", "port": 22 },
  "notificationCommand": {
    "executable": "<full-path-to-Windows-node.exe>",
    "args": ["<private-folder>/monitor-mail.js", "--config", "<private-folder>/monitor-mail.json"]
  }
}
```

Use literal Tailscale IPv4 or IPv6 addresses (put IPv6 in brackets in the URL). The gateway URL must contain no
username, password, path, query or fragment. Choose a port that really answers on a different Tailscale computer
for the independent probe. Prove both connections from Windows before enabling the task. The mail command must
already work on that account. Keep credentials in its own private files or credential store, never command arguments.

Under the private folder, place the verified `imap-mcp-server` build (`dist/`, `package.json` and
`package-lock.json`), then run `npm ci --omit=dev --ignore-scripts` there in the monitor account. Supply
`monitor-mail.json` with `address` (the approved Community Tech sender and inbox), `tenantId`, `clientId`,
`certThumbprint` and `privateKeyFile` (the certificate key's filename, ending in `.pem` or `.key`). Rebuild
the mail credentials from their approved vault entry directly into the monitor account's private folder.
The mail server build needs no copy of its other accounts or environment files.

The sender reads one JSON object on stdin, `{id, subject, text}`, and submits to the configured inbox only.
Keep `monitor-mail-ledger.sqlite` alongside the monitor's state across upgrades. It records the stable message
identifier before submission. The sender can retry a definite rejection and checks for the exact message in
Sent Items when acceptance is uncertain. An absent result is not grounds to send again. Reconcile an alert
that remains pending against the mailbox before considering any manual resend.

In the installed home-base Harness, go to **Settings → Phone & remote → Mobile**, select **Mine** if asked whose
phone to pair, and select **Generate pairing code**, then **Copy connection code**. Sign into `HarnessMonitor`
on the PC and paste the full copied connection code into this PowerShell prompt. The pairing token goes to the
monitor through stdin.

```powershell
$folder = Join-Path $env:LOCALAPPDATA 'Harness\home-base-monitor'
$code = Read-Host 'Paste the home-base connection code' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($code)
try {
  try {
    $pairing = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'Copy the full connection code from the home-base Mobile settings and paste it again.'
  }
  if ($pairing.v -ne 1 -or -not ($pairing.pairingToken -is [string]) -or -not $pairing.pairingToken.Trim()) {
    throw 'The connection code is missing its pairing token.'
  }
  $pairing.pairingToken | & node (Join-Path $folder 'monitor.js') pair --config (Join-Path $folder 'monitor.json')
  if ($LASTEXITCODE -ne 0) { throw 'Monitor pairing did not complete.' }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  Remove-Variable code, pointer, pairing -ErrorAction SilentlyContinue
}
```

The resulting `device-token.json` is private and outside the checkout. It grants owner-level access and can be
revoked from the home base. Keep it in the separate monitor account. The gateway renews valid tokens as they are
used and rejects revoked or idle-expired tokens. The original expiry in this file does not determine whether
the paired monitor can still connect. Never copy a token into a plan, test, log or chat.

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
  An unconfirmed delivery goes to the end of the queue, so later alerts can still be delivered.

The list currently caps at 100 jobs. A response at that cap is refused because it cannot prove the list is complete;
add pagination before enrolling 100 jobs. The monitor is silent while the PC is asleep, restarting, or its account
is signed out. It cannot report its own computer being unavailable. Scheduled-task installation, the private-folder
permissions and real mail delivery need live Windows verification before rollout.
