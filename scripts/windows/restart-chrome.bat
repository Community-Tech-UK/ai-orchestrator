@echo off
REM ---------------------------------------------------------------------------
REM Restart the everyday Chrome on this machine so the Browser Gateway
REM extension relay comes back.
REM
REM Source of truth: scripts\windows\restart-chrome.bat
REM Deployed copy:   %USERPROFILE%\.orchestrator\_scratch\aio-transfers\restart-chrome.bat
REM                  (upload_to_node cannot write to the Desktop root, which is
REM                  read-only for file transfer - copy it there if you want it
REM                  to hand.)
REM
REM Unlike restart-worker.bat, this script may be run from anywhere, including
REM inside the repo: it triggers no `git pull`, so there is no risk of the file
REM being rewritten underneath cmd.exe while it executes.
REM
REM WHY THIS EXISTS
REM The coordinator reaches shared Chrome tabs through a chain:
REM   coordinator <- poll RPC <- worker relay <- native messaging host <- extension SW
REM Those hops fail INDEPENDENTLY, and the one this script fixes is the last one.
REM The MV3 service worker can keep its long-poll loop alive while the half that
REM actually executes commands is dead. The coordinator then sees a perfectly
REM fresh channel - polls landing every second - and every command it sends times
REM out as browser_extension_command_timeout.
REM
REM Observed on windows-pc 2026-09-20: tab inventory frozen 9.3h, channelState
REM 'fresh', commandsDeliverable true, and click/evaluate/navigate/snapshot/
REM accessibility_snapshot all timing out. browser.recover_extension REFUSED to
REM act because health did not classify it as an incident.
REM
REM Restarting the worker relay does not always clear it - the relay and the
REM native host are both healthy in this failure. The dead component is the
REM extension's service worker, and the only thing that reliably replaces it is
REM restarting Chrome.
REM
REM WHAT IT DELIBERATELY DOES NOT TOUCH
REM Chrome running against the managed browser-automation profile is EXCLUDED.
REM That is a separate Harness-controlled instance with its own user-data-dir;
REM it does not serve shared tabs and killing it would drop unrelated managed
REM sessions for no reason. Same spirit as restart-worker.bat leaving the
REM native-host helpers alone.
REM
REM WHY THE POWERSHELL LIVES IN THE TAIL OF THIS FILE
REM Same reason as restart-worker.bat: passing a real script through
REM `powershell -Command "..."` means fighting cmd's naive quote counting and
REM PowerShell's parser at once, and a `|` landing while cmd's quote state is
REM OFF silently becomes a cmd pipe. Stored below the marker and read back from
REM disk instead, so it is plain PowerShell with no escaping at all.
REM
REM Keep this file pure ASCII.
REM ---------------------------------------------------------------------------
setlocal

REM Path passed through the environment, never interpolated into the PowerShell
REM string: C:\Users\O'Brien\Desktop\... is an ordinary Windows profile and would
REM terminate a single-quoted PS literal.
set "AIO_SELF=%~f0"

REM Unattended runs (run_on_node, a scheduled task) must not block on `pause`.
REM Set AIO_NO_PAUSE=1 to skip it.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:AIO_SELF); Invoke-Expression $s.Substring($s.LastIndexOf('#PS_START'))"

set "AIO_RC=%ERRORLEVEL%"
echo.
if not "%AIO_NO_PAUSE%"=="1" pause
endlocal & exit /b %AIO_RC%

REM LastIndexOf, not IndexOf: the marker name also appears in the bootstrap line
REM above, and the first match would slice the file from there.

#PS_START
$ErrorActionPreference = 'Continue'

# The managed profile lives under .orchestrator and is driven by chrome-devtools,
# not by the extension relay. Matched on the user-data-dir switch rather than the
# folder name alone so a stray window whose TITLE mentions it is not spared.
$managedMarker = 'browser-automation-profile'

function Get-SharedChrome {
    $procs = @()
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop)
    } catch {
        return @()
    }
    # IndexOf/OrdinalIgnoreCase rather than -like: -like reads [ and ] as a
    # character class, so a profile such as C:\Users\John[Contractor] would never
    # match its own browser.
    return @($procs | Where-Object {
        $_.CommandLine -and
        $_.CommandLine.IndexOf($managedMarker, [StringComparison]::OrdinalIgnoreCase) -lt 0
    })
}

function Get-ChromePath {
    # App Paths first - it is what the shell itself resolves, so it survives a
    # per-user install under AppData that the Program Files guesses would miss.
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
    )
    foreach ($k in $keys) {
        try {
            $v = (Get-ItemProperty -LiteralPath $k -ErrorAction Stop).'(default)'
            if ($v -and (Test-Path -LiteralPath $v)) { return $v }
        } catch { }
    }
    $guesses = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($g in $guesses) {
        if ($g -and (Test-Path -LiteralPath $g)) { return $g }
    }
    return $null
}

Write-Host ''
Write-Host '=========================================================='
Write-Host '  Restarting Chrome (Browser Gateway extension relay)'
Write-Host '=========================================================='
Write-Host ''

# --- 1. What is running now ------------------------------------------------
Write-Host '[1/5] Current shared-tab Chrome processes:'
$before = @(Get-SharedChrome)
if ($before.Count -gt 0) {
    $oldest = ($before | Sort-Object CreationDate | Select-Object -First 1)
    Write-Host ('      {0} chrome.exe process(es), oldest started {1}' -f $before.Count, $oldest.CreationDate)
} else {
    Write-Host '      (none running)'
}
$managed = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($managedMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if ($managed.Count -gt 0) {
    Write-Host ('      ({0} managed-profile process(es) will be left alone)' -f $managed.Count)
}
Write-Host ''

# --- 1b. Are we the account that owns this Chrome? -------------------------
# Win32_Process hides CommandLine for other users' processes, so a shell in the
# wrong account sees an empty list and would cheerfully "start" a second Chrome
# under a profile that serves no shared tabs at all. Same trap restart-worker.bat
# documents for the worker.
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$owner = $null
foreach ($p in $before) {
    try {
        $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
        if ($o.User) { $owner = ('{0}\{1}' -f $o.Domain, $o.User); break }
    } catch { }
}
if ($owner -and $owner -ne $me) {
    Write-Host ('  *** Wrong account. Chrome runs as {0}; you are {1}. ***' -f $owner, $me)
    Write-Host '  Restarting it from here would relaunch into THIS profile, which'
    Write-Host '  has none of the shared logged-in tabs.'
    Write-Host ('  Log in as {0} and run this from that desktop.' -f $owner)
    exit 5
}
Write-Host ''

# --- 2. Ask Chrome to close itself -----------------------------------------
# CloseMainWindow first, never a bare Stop-Process. A forced kill skips the
# profile flush, and Chrome then treats the next launch as a crash: the session
# restore prompt appears instead of the tabs, and "Continue where you left off"
# can be silently dropped. The logged-in shared tabs are the whole point of this
# channel, so they have to come back on their own.
Write-Host '[2/5] Asking Chrome to close (graceful, keeps the session)...'
$closed = 0
foreach ($p in $before) {
    try {
        $proc = Get-Process -Id $p.ProcessId -ErrorAction Stop
        if ($proc.MainWindowHandle -ne 0) {
            if ($proc.CloseMainWindow()) { $closed++ }
        }
    } catch { }
}
Write-Host ('      close requested on {0} window(s)' -f $closed)

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline -and @(Get-SharedChrome).Count -gt 0) {
    Start-Sleep -Milliseconds 500
}
Write-Host ''

# --- 3. Force anything that ignored the request ----------------------------
# Renderers with a beforeunload handler, or a hung GPU process, will sit there
# forever. By this point the browser process has already flushed its profile, so
# forcing the stragglers no longer costs the session.
Write-Host '[3/5] Forcing any leftovers...'
$left = @(Get-SharedChrome)
if ($left.Count -eq 0) {
    Write-Host '      none left'
} else {
    foreach ($r in $left) {
        try {
            Stop-Process -Id $r.ProcessId -Force -ErrorAction Stop
            Write-Host ('      stopped pid {0}' -f $r.ProcessId)
        } catch {
            Write-Host ('      could not stop pid {0}: {1}' -f $r.ProcessId, $_.Exception.Message)
        }
    }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and @(Get-SharedChrome).Count -gt 0) {
        Start-Sleep -Milliseconds 500
    }
}
if (@(Get-SharedChrome).Count -gt 0) {
    Write-Host ''
    Write-Host '  *** Could not stop every Chrome process. ***'
    Write-Host '  Nothing was relaunched, so the relay is still dead.'
    Write-Host '  Re-run this from an ELEVATED prompt, or reboot.'
    exit 1
}
Write-Host '      all stopped'
Write-Host ''

# --- 4. Start it again ------------------------------------------------------
Write-Host '[4/5] Starting Chrome...'
$chrome = Get-ChromePath
if (-not $chrome) {
    Write-Host ''
    Write-Host '  *** Could not find chrome.exe. ***'
    Write-Host '  Looked in App Paths (HKLM + HKCU), Program Files, Program Files (x86)'
    Write-Host '  and LocalAppData. Start Chrome by hand.'
    exit 2
}
Write-Host ('      {0}' -f $chrome)

# --restore-last-session rather than trusting the startup preference: the box is
# a worker, and whatever that setting happens to be, the shared tabs must come
# back or the channel has nothing to serve.
#
# No --user-data-dir: omitting it is what selects the DEFAULT profile, the one
# holding the real cookies the extension relay shares. Passing the managed
# profile here would relaunch into exactly the instance step 1 excluded.
try {
    Start-Process -FilePath $chrome -ArgumentList '--restore-last-session' -ErrorAction Stop | Out-Null
} catch {
    Write-Host ('  *** Could not launch Chrome: {0} ***' -f $_.Exception.Message)
    exit 2
}
Write-Host ''

# --- 5. Confirm it came back ------------------------------------------------
Write-Host '[5/5] Waiting for Chrome to come back (up to 60 seconds)...'
$deadline = (Get-Date).AddSeconds(60)
$after = @()
while ((Get-Date) -lt $deadline) {
    $after = @(Get-SharedChrome)
    if ($after.Count -gt 0) { break }
    Start-Sleep -Seconds 2
}
if ($after.Count -eq 0) {
    Write-Host ''
    Write-Host '  *** Chrome did not come back. ***'
    Write-Host '  Start it by hand and check the extension is still enabled.'
    exit 3
}
Write-Host ('      {0} chrome.exe process(es) running' -f $after.Count)

# The native messaging host is spawned BY Chrome when the extension connects, so
# its presence is the first real evidence the relay end of the chain is alive
# again - a chrome.exe that is up but never connected the extension looks
# identical from the process list alone.
Write-Host ''
Write-Host '      Waiting for the native messaging host to be spawned...'
$deadline = (Get-Date).AddSeconds(45)
$host_up = $false
while ((Get-Date) -lt $deadline) {
    $hosts = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('native-host', [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($hosts.Count -gt 0) { $host_up = $true; break }
    Start-Sleep -Seconds 2
}
if ($host_up) {
    Write-Host '      native messaging host is up'
} else {
    Write-Host '      *** native host has NOT appeared after 45s ***'
    Write-Host '      Chrome is running but the extension has not connected. Check that'
    Write-Host '      the AIO Browser Gateway extension is enabled in chrome://extensions.'
}

Write-Host ''
Write-Host '=========================================================='
Write-Host '  Done.'
Write-Host ''
Write-Host '  Verify from the Mac - browser_list_targets with refresh:true'
Write-Host '  should now return targets whose lastSeenAt is SECONDS old.'
Write-Host '  A fresh lastContactAt beside a stale lastSeenAt means the'
Write-Host '  service worker came back still broken; run this again.'
Write-Host '=========================================================='
if (-not $host_up) { exit 4 }
exit 0
