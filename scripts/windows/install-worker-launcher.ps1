<#
.SYNOPSIS
  Deploy the AI Orchestrator worker launcher and (optionally) register the
  scheduled task that keeps it alive.

.DESCRIPTION
  Two defects combined to cause the 2026-09-03 outage, and they lived in
  different places - which is why this script does two different things.

    1. The scheduled task's action was `cmd /c start ...`, which DETACHES. The
       task therefore "succeeded" in milliseconds and could never detect that the
       worker had died, making its RestartOnFailure setting inert. Its trigger was
       also logon-only, so recovery required a human. This lived in a hand-made,
       UNTRACKED file in %USERPROFILE%\.orchestrator that nobody could review.
       Rendering it from a tracked template is the fix.
    2. start-worker.bat ran the worker without --supervise, so a single process
       exit left the node dead. That file was TRACKED in the repo the whole time.
       Version control did not catch it. Hence the anchored guard below, which
       refuses to deploy when the `node` command has lost the flag - review alone
       had already failed once.

  This script makes the launch chain reproducible from tracked templates, and
  records drift stamps so a later divergence is detectable rather than silent.

  The deployed launcher must live OUTSIDE the repo because it runs `git pull` on
  that repo, and cmd.exe reads a running .bat incrementally by byte offset. The
  templates in scripts/windows/ are the source of truth; this script renders them.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 `
    -RepoPath 'C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator' -WhatIf

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 `
    -RepoPath 'C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator' -RegisterTask
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,

  # NOTE: start-worker.bat hardcodes %USERPROFILE%\.orchestrator when it looks for
  # the launcher files and stamps, and has no way to discover a custom root.
  # The two drift COMPARISONS still fail safe under an override - no stamp found
  # means no warning, never a false alarm. The "not fully installed" check does
  # NOT: it warns precisely because the default root is empty, so a successful
  # install under a non-default root makes it cry wolf on every worker start.
  # Overriding this is supported for testing; on a machine that actually runs the
  # worker, leave it at the default.
  [string]$InstallRoot = (Join-Path $env:USERPROFILE '.orchestrator'),

  [string]$TaskName = 'AI Orchestrator Worker',

  # How often Task Scheduler re-checks that the worker is running. The task uses
  # MultipleInstancesPolicy=IgnoreNew and the worker holds a single-instance
  # lock, so a repeat while healthy is a no-op.
  [int]$RepeatMinutes = 5,

  # The account the worker actually runs as, which is NOT always the account you
  # are running this script as. "Run as administrator" can switch you into a
  # separate admin account; do that and every default here silently follows the
  # WRONG profile - $env:USERPROFILE, and therefore -InstallRoot, and the task's
  # principal and logon trigger. On 2026-09-06 that produced a task registered for
  # 9950x3d\CTAdmin pointing at C:\Users\CTAdmin\.orchestrator\run-worker-hidden.vbs,
  # which the worker user could not even read. It looked registered, reported an
  # armed NextRunTime, and could never run: LogonType Interactive for an account
  # with no interactive session just accumulates missed runs.
  [string]$WorkerUser = "$env:USERDOMAIN\$env:USERNAME",

  [switch]$RegisterTask
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Tri-state, because "I could not tell" is a real answer and collapsing it into
# "no" is how a tool starts lying. `Get-ScheduledTask -TaskName X -ErrorAction
# SilentlyContinue` hides a stopped Task Scheduler service exactly as well as it
# hides an absent task, and the registration-failure diagnosis below reads this
# value: told "no" while the service was down, it would confidently rule elevation
# out and send the operator hunting a bad principal instead. Enumerating throws on
# a genuine service or permission fault, which is the distinction we need.
function Get-TaskPresence {
  param([string]$Name)
  try {
    $all = Get-ScheduledTask -ErrorAction Stop
  } catch {
    return 'unknown'
  }
  if ($all | Where-Object { $_.TaskName -eq $Name }) { return 'yes' }
  return 'no'
}

# Resolve an account's real profile directory from the SID, rather than trusting
# $env:USERPROFILE, which describes whoever is running this script and not
# necessarily the account the worker runs as.
function Get-UserProfilePath {
  param([string]$Account)
  try {
    $sid = (New-Object Security.Principal.NTAccount($Account)).Translate(
      [Security.Principal.SecurityIdentifier]).Value
  } catch {
    return $null
  }
  $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
  $entry = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if (-not $entry) { return $null }
  if (-not $entry.PSObject.Properties['ProfileImagePath']) { return $null }
  return $entry.ProfileImagePath
}

function Assert-NotOneDrivePath {
  param([string]$PathValue, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return }
  $normalized = $PathValue -replace '/', '\'
  if ($normalized -match '(?i)(^|\\)OneDrive(?:\s+-\s+[^\\]+)?($|\\)') {
    throw "$Label must not be under OneDrive: $PathValue"
  }
}

# Keep this many historical backups per file. Without pruning, every re-run of
# the installer adds three files to the install root forever - the same
# unbounded-growth problem this change set just fixed for worker-stderr.log.
$script:MaxBackups = 5

function Remove-OldBackups {
  param([string]$Directory, [string]$Filter)
  $old = Get-ChildItem -LiteralPath $Directory -Filter $Filter -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $script:MaxBackups
  foreach ($item in $old) {
    Remove-Item -LiteralPath $item.FullName -Force -ErrorAction SilentlyContinue
    Write-Verbose "Pruned old backup $($item.FullName)"
  }
}

function Backup-IfPresent {
  param([string]$PathValue)
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return $null }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = "$PathValue.$stamp.bak"
  Copy-Item -LiteralPath $PathValue -Destination $backup -Force
  Write-Verbose "Backed up existing $PathValue -> $backup"
  Remove-OldBackups -Directory (Split-Path -Parent $PathValue) -Filter "$(Split-Path -Leaf $PathValue).*.bak"
  return $backup
}

function Write-RenderedTemplate {
  param(
    [string]$TemplatePath,
    [string]$Destination,
    [hashtable]$Tokens
  )
  if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
    throw "Template not found: $TemplatePath"
  }
  $content = Get-Content -LiteralPath $TemplatePath -Raw
  foreach ($key in $Tokens.Keys) {
    $content = $content.Replace($key, $Tokens[$key])
  }
  if ($content -match '__[A-Z_]+__') {
    throw "Unsubstituted token left in rendered output for $Destination"
  }
  if ($PSCmdlet.ShouldProcess($Destination, 'Write launcher file')) {
    Backup-IfPresent -PathValue $Destination | Out-Null
    Set-Content -LiteralPath $Destination -Value $content -Encoding ASCII -NoNewline:$false
    Write-Host "  wrote $Destination"
  }
}

# --- validate -----------------------------------------------------------------

$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path.TrimEnd('\')
Assert-NotOneDrivePath -PathValue $RepoPath -Label 'RepoPath'
Assert-NotOneDrivePath -PathValue $InstallRoot -Label 'InstallRoot'

$startWorker = Join-Path $RepoPath 'start-worker.bat'
if (-not (Test-Path -LiteralPath $startWorker -PathType Leaf)) {
  throw "RepoPath does not look like the ai-orchestrator repo (no start-worker.bat): $RepoPath"
}

# Fail loudly if the repo copy has lost supervision again - the whole reason this
# script exists.
#
# The pattern is anchored to the `node` COMMAND, not to the flag anywhere in the
# file. A bare '--supervise' search is satisfied by start-worker.bat's own
# explanatory REM comment, so it would pass on exactly the regression it claims
# to catch: someone edits the node line and leaves the comment behind.
if (-not (Select-String -LiteralPath $startWorker -Pattern '(?im)^\s*(call\s+)?node\b.*--supervise' -Quiet)) {
  throw "start-worker.bat has no 'node ... --supervise' command. Refusing to install an unsupervised launcher: $startWorker"
}

# Am I elevated? Computed once: two different checks below need it.
$isElevated = (New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

# The trap this catches is subtle enough to deserve a nudge even when nothing is
# provably wrong. On a machine where "Run as administrator" signs you into a
# SEPARATE admin account, every default here follows that account - and it does so
# CONSISTENTLY, so -InstallRoot and -WorkerUser agree with each other and the
# consistency check below passes happily while the whole install lands in the
# wrong profile. Only the operator knows which account runs the worker, so say
# which one we are about to use and let them correct it.
#
# A warning, not a throw: where UAC elevates the same account - the common case -
# this is merely redundant, and refusing there would be an over-correction.
if ($isElevated -and -not $PSBoundParameters.ContainsKey('WorkerUser')) {
  Write-Warning "Running elevated as '$env:USERDOMAIN\$env:USERNAME' and -WorkerUser was not given, so the worker will be installed FOR THAT ACCOUNT. If 'Run as administrator' put you in a different account from the one that runs the worker, re-run with -WorkerUser and -InstallRoot naming the worker's account."
}

# Refuse to install into a profile that does not belong to the account the worker
# will run as.
#
# Deliberately NOT gated on -RegisterTask: the four launcher files are deployed
# either way, so scattering them into the wrong profile does not need the task
# step to happen. Running before any write is the whole point - cleaning up a
# half-install in another account's profile needs elevation all over again.
$workerProfile = Get-UserProfilePath -Account $WorkerUser
if (-not $workerProfile) {
  Write-Warning "Could not resolve a profile directory for '$WorkerUser' (no ProfileList entry - the account may never have logged on here); skipping the install-root consistency check. Verify the deployed paths by hand."
} else {
  # Equality is legitimate: -InstallRoot may point at the profile root itself.
  # Otherwise require a real directory boundary, so C:\Users\shutuX is not read as
  # living inside C:\Users\shutu. GetFullPath does not collapse 8.3 short names,
  # subst drives or UNC equivalents of the same directory, so a root hand-typed in
  # one of those forms can still be refused; give the plain path instead.
  $rootFull = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $profFull = [IO.Path]::GetFullPath($workerProfile).TrimEnd('\')
  $inside = $rootFull.Equals($profFull, [StringComparison]::OrdinalIgnoreCase) -or
            $rootFull.StartsWith($profFull + '\', [StringComparison]::OrdinalIgnoreCase)
  if (-not $inside) {
    # Carry every parameter actually in force. A corrected command that quietly
    # reverts -TaskName or -RepeatMinutes to their defaults would register a
    # DIFFERENT task and leave the operator's real one just as broken - the exact
    # trap the registration-failure message further down already avoids.
    #
    # -WhatIf included for the same reason, and it is the sharpest case: this guard
    # is deliberately NOT wrapped in ShouldProcess, so it fires during a dry run
    # too. Someone previewing first - which this script's own .EXAMPLE tells them
    # to do - would otherwise be handed a command that silently performs the real
    # install. A correction must never be more dangerous than what it corrects.
    $fixed = "powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -RepoPath `"$RepoPath`"" +
             " -InstallRoot `"$(Join-Path $workerProfile '.orchestrator')`"" +
             " -WorkerUser `"$WorkerUser`" -TaskName `"$TaskName`" -RepeatMinutes $RepeatMinutes" +
             $(if ($RegisterTask) { ' -RegisterTask' } else { '' }) +
             $(if ($WhatIfPreference) { ' -WhatIf' } else { '' })
    throw @"
Install root does not belong to the worker account. Nothing has been written.

  worker account : $WorkerUser
  its profile    : $workerProfile
  -InstallRoot   : $InstallRoot
  running as     : $env:USERDOMAIN\$env:USERNAME

You are almost certainly in an elevated shell for a different admin account, so
the default -InstallRoot followed that account's profile instead of the worker's.
Re-run naming them explicitly:

  $fixed
"@
  }
}

$taskPresence = 'unknown'
if ($RegisterTask) {
  $taskPresence = Get-TaskPresence -Name $TaskName
  # Gated on a task ALREADY EXISTING, not merely on -RegisterTask. Creating a task
  # for the current interactive user does not normally need elevation; it is
  # replacing one somebody else registered elevated that gets refused. Warning
  # unconditionally would train the reader to ignore it on exactly the first run
  # where it is noise.
  if ($taskPresence -eq 'yes' -and -not $isElevated) {
    $filesNote = if ($WhatIfPreference) { 'this is a dry run, so nothing will be written' }
                 else { 'the launcher files will still deploy' }
    Write-Warning "Not running elevated, and a task named '$TaskName' already exists. Replacing it requires elevation; $filesNote, and the task step will print the exact command to re-run if it is refused."
  }
}

$templateDir = Join-Path $RepoPath 'scripts\windows'
$batTemplate = Join-Path $templateDir 'start-worker-autoupdate.template.bat'
$vbsTemplate = Join-Path $templateDir 'run-worker-hidden.template.vbs'

if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
  if ($PSCmdlet.ShouldProcess($InstallRoot, 'Create install directory')) {
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  }
}

$deployedBat = Join-Path $InstallRoot 'start-worker-autoupdate.bat'
$deployedVbs = Join-Path $InstallRoot 'run-worker-hidden.vbs'

# --- deploy -------------------------------------------------------------------

Write-Host "Deploying worker launcher from $templateDir"
Write-RenderedTemplate -TemplatePath $batTemplate -Destination $deployedBat -Tokens @{
  '__REPO_PATH__' = $RepoPath
}
Write-RenderedTemplate -TemplatePath $vbsTemplate -Destination $deployedVbs -Tokens @{
  '__LAUNCHER_PATH__' = $deployedBat
}

# Drift stamps. The whole reason this incident went unnoticed for weeks is that
# the deployed launcher was untracked, so nobody could see it had diverged.
# Tracking the template makes it REVIEWABLE; these stamps make divergence
# DETECTABLE. start-worker.bat compares both on every launch and warns (never
# rewrites - rewriting the running .bat is the byte-offset hazard the template
# header describes).
#
# TWO stamps, because they catch different failures:
#   template - the repo moved on (a pull brought a new template): re-run me.
#   deployed - someone hand-edited the deployed launcher. THAT is the
#              2026-09-03 failure mode, and a template-only stamp misses it
#              entirely because the template is untouched.
$templateStamp = Join-Path $InstallRoot 'launcher-template.sha256'
if ($PSCmdlet.ShouldProcess($templateStamp, 'Write template drift stamp')) {
  $templateHash = (Get-FileHash -LiteralPath $batTemplate -Algorithm SHA256).Hash
  Set-Content -LiteralPath $templateStamp -Value $templateHash -Encoding ASCII
  Write-Host "  wrote $templateStamp"
}

$deployedStamp = Join-Path $InstallRoot 'launcher-deployed.sha256'
if ($PSCmdlet.ShouldProcess($deployedStamp, 'Write deployed-launcher drift stamp')) {
  $deployedHash = (Get-FileHash -LiteralPath $deployedBat -Algorithm SHA256).Hash
  Set-Content -LiteralPath $deployedStamp -Value $deployedHash -Encoding ASCII
  Write-Host "  wrote $deployedStamp"
}

# --- scheduled task -----------------------------------------------------------

if (-not $RegisterTask) {
  Write-Host ''
  if ($WhatIfPreference) {
    Write-Host 'Dry run only - nothing was written. Re-run without -WhatIf to deploy.'
  } else {
    Write-Host 'Launcher files deployed. Scheduled task left untouched (pass -RegisterTask to update it).'
  }
  return
}

# The worker account, not whoever is running this script. See -WorkerUser.
$userId = $WorkerUser

# Get-ScheduledTask searches every task folder, but Export/Register default to
# the root '\'. Carry the existing task's own TaskPath through, or a task living
# in a subfolder would fail to export and then be duplicated at the root.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$taskPath = if ($existing) { $existing.TaskPath } else { '\' }

if ($existing) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $safeName = $TaskName -replace '[^\w\-]', '_'
  $xmlBackup = Join-Path $InstallRoot "$safeName.$stamp.task.xml"
  if ($PSCmdlet.ShouldProcess($xmlBackup, 'Back up existing scheduled task definition')) {
    Export-ScheduledTask -TaskName $TaskName -TaskPath $taskPath | Set-Content -LiteralPath $xmlBackup -Encoding UTF8
    Write-Host "  backed up existing task definition -> $xmlBackup"
    Write-Host "  restore with: Register-ScheduledTask -Xml (Get-Content -Raw '$xmlBackup') -TaskName '$TaskName' -TaskPath '$taskPath'"
    Remove-OldBackups -Directory $InstallRoot -Filter "$safeName.*.task.xml"
  }
}

# Action: wscript runs the hidden VBS, which BLOCKS on the worker. That is what
# lets Task Scheduler observe the worker's real lifetime instead of returning
# instantly the way `cmd /c start` did.
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$deployedVbs`"" -WorkingDirectory $RepoPath

# TWO separate triggers, and the split is the whole point.
#
# A repetition attached to a LOGON trigger only begins when that trigger
# activates - at the next logon. Register the task from an already-established
# session (the normal case: you are sitting at the machine) and the keep-alive is
# dormant until the user next logs off and on. That state is indistinguishable
# from a working install until the moment you need it. On 2026-09-05 the worker
# died at 15:23 and nothing came for it for six hours.
#
# So the keep-alive gets its OWN time trigger, whose repetition runs from its
# start boundary regardless of session state, and the logon trigger is left to do
# nothing but start the worker promptly at logon. After registration we assert
# NextRunTime is populated - that is the observable which separates "actually
# scheduled" from "serialised but dormant", and the XML alone cannot tell them
# apart.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$keepAliveTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes)
$triggers = @($logonTrigger, $keepAliveTrigger)

$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

# The worker drives Chrome and the Android emulator, so it needs the interactive
# desktop session. Do NOT switch this to a service/S4U principal.
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

if ($PSCmdlet.ShouldProcess($TaskName, 'Register scheduled task')) {
  # Replacing an existing task needs rights over that task, which a standard user
  # does not have when it was created elevated. Left bare, that surfaces as a raw
  # "Access is denied" pointing at this line, AFTER the launcher files have
  # already been written - which reads like a total failure when in fact only the
  # task step was refused. Say what to do about it.
  try {
    Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -Action $action -Trigger $triggers `
      -Settings $settings -Principal $principal -Force | Out-Null
  } catch {
    # Do not assert a cause that was not tested. Elevation is only the likely
    # explanation when a task was ALREADY there to be replaced; a first-time
    # registration failing is far more likely to be a bad principal, a missing
    # logon right, or a malformed trigger, and sending that operator away to
    # elevate wastes the one message they get. Report what is known and let the
    # underlying exception speak for the rest.
    #
    # Echo back the parameters actually in force too. A re-run line hardcoded to
    # the defaults would quietly retarget a non-default -InstallRoot or -TaskName,
    # registering a second task somewhere else while the real one stayed broken.
    $rerun = "powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -RepoPath `"$RepoPath`" -InstallRoot `"$InstallRoot`" -WorkerUser `"$WorkerUser`" -TaskName `"$TaskName`" -RepeatMinutes $RepeatMinutes -RegisterTask"
    $diagnosis = if ($taskPresence -eq 'yes') {
@"
A task named '$TaskName' already existed, and replacing one usually requires
elevation. Re-run this script from an ELEVATED PowerShell (right-click >
Run as administrator):

  $rerun
"@
    } elseif ($taskPresence -eq 'no') {
@"
No task named '$TaskName' existed, so this was a first-time registration and
elevation is probably NOT the cause - read the error above before assuming it is.
Common causes are a principal the current user cannot register, a missing logon
right, or a rejected trigger. The command that failed was:

  $rerun
"@
    } else {
@"
Scheduled tasks could not be listed earlier, so whether '$TaskName' already
existed is unknown and NEITHER elevation nor a first-time registration fault can
be ruled out. Check the Task Scheduler service is running, then read the error
above. The command that failed was:

  $rerun
"@
    }
    throw @"
Could not register the scheduled task '$TaskName': $($_.Exception.Message)

The launcher files in $InstallRoot were deployed; only the task step failed.
$diagnosis
Until it succeeds, nothing will restart this worker if its process tree dies.
"@
  }
  Write-Host "  registered scheduled task '$TaskName' (logon + keep-alive every $RepeatMinutes min)"

  # Read the registered task back and assert the two settings that silently
  # break the design if they ever change: the repetition must be indefinite, and
  # the execution time limit must be unlimited. PowerShell's docs do not state
  # what an omitted RepetitionDuration produces, and a silently finite value in
  # either place is the same "looks fine, isn't" failure as the detached action
  # this replaces. Check, do not assume.
  #
  # This whole block is best-effort. It runs immediately after a SUCCESSFUL
  # registration, so it must never throw: an exception here would look exactly
  # like the registration having failed. Note also that the correct serialisation
  # contains NO <Duration> element, so the check has to use SelectSingleNode -
  # a dotted `.Duration` would be a missing-property reference, which
  # Set-StrictMode -Version Latest turns into a terminating error.
  try {
    $xml = [xml](Export-ScheduledTask -TaskName $TaskName -TaskPath $taskPath)
    $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    # ExecutionTimeLimit lives under Settings, not under the trigger. This one
    # matters as much as the repetition: the documented DEFAULT stops a task
    # after 72 hours, and because our action BLOCKS for the worker's lifetime,
    # anything other than PT0S would kill a perfectly healthy worker every three
    # days.
    $etl = $xml.SelectSingleNode('//t:Settings/t:ExecutionTimeLimit', $ns)
    if (-not $etl) {
      Write-Warning 'No ExecutionTimeLimit in the registered task; expected PT0S (unlimited). A healthy worker may be killed when the default limit expires.'
    } elseif ($etl.InnerText -ne 'PT0S') {
      Write-Warning "ExecutionTimeLimit is '$($etl.InnerText)', expected PT0S (unlimited); a healthy worker will be killed when it expires."
    } else {
      Write-Host '  verified execution time limit: PT0S (unlimited)'
    }

    # The keep-alive repetition lives on the TIME trigger, not the logon trigger -
    # see the trigger block above for why. Looking it up under LogonTrigger would
    # now silently find nothing and report a broken keep-alive on a good install.
    $repetition = $xml.SelectSingleNode('//t:TimeTrigger/t:Repetition', $ns)
    if (-not $repetition) {
      Write-Warning 'Registered task has NO repetition block on its time trigger - the keep-alive is not active.'
    } else {
      $interval = $repetition.SelectSingleNode('t:Interval', $ns)
      $duration = $repetition.SelectSingleNode('t:Duration', $ns)
      if (-not $interval) {
        Write-Warning 'Registered task has NO repetition interval - the keep-alive is not active.'
      } elseif ($duration) {
        Write-Warning "Repetition duration is finite ($($duration.InnerText)); the keep-alive will stop then. Expected indefinite."
      } else {
        Write-Host "  verified repetition: every $($interval.InnerText), indefinitely"
      }
    }

    # The XML can serialise a perfect repetition that Task Scheduler is not
    # actually counting down - that is exactly the trap the time trigger exists to
    # avoid, so prove it rather than assume it. A populated NextRunTime is the only
    # evidence that the keep-alive is armed right now, in this session.
    $nextRun = (Get-ScheduledTask -TaskName $TaskName -TaskPath $taskPath | Get-ScheduledTaskInfo).NextRunTime
    if (-not $nextRun) {
      # Double-quoted here-string on purpose: the single-quoted form does not
      # interpolate, so a hardcoded name would send an operator who passed
      # -TaskName off to inspect a task that is either absent or, on a host
      # running two workers, somebody else's.
      Write-Warning @"
Task registered but NextRunTime is EMPTY - the keep-alive is NOT armed, so a dead
worker will not be picked up. Check that the time trigger survived registration:
  (Get-ScheduledTask -TaskName '$TaskName').Triggers | Format-List *
"@
    } else {
      Write-Host "  verified keep-alive is armed: next run at $nextRun"
    }
  } catch {
    Write-Warning "Could not verify the trigger settings (the task WAS registered): $_"
  }
}

Write-Host ''
Write-Host 'Done. The task will start the worker at logon and re-check every'
Write-Host "$RepeatMinutes minutes. It does NOT start it now - run the task manually or"
Write-Host 'log off and on:'
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
