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

  # NOTE: start-worker.bat's drift check hardcodes %USERPROFILE%\.orchestrator
  # when looking for the stamp files. Overriding this is supported for testing,
  # but a non-default install root silently disables that check (it fails safe -
  # no stamp found means no warning, never a false alarm).
  [string]$InstallRoot = (Join-Path $env:USERPROFILE '.orchestrator'),

  [string]$TaskName = 'AI Orchestrator Worker',

  # How often Task Scheduler re-checks that the worker is running. The task uses
  # MultipleInstancesPolicy=IgnoreNew and the worker holds a single-instance
  # lock, so a repeat while healthy is a no-op.
  [int]$RepeatMinutes = 5,

  [switch]$RegisterTask
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

$userId = "$env:USERDOMAIN\$env:USERNAME"

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

# Logon trigger, plus repetition so a dead worker is picked up within
# $RepeatMinutes instead of waiting for the next logon.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$repeatSource = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes)
$trigger.Repetition = $repeatSource.Repetition

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
  Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "  registered scheduled task '$TaskName' (logon + every $RepeatMinutes min)"

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

    $repetition = $xml.SelectSingleNode('//t:LogonTrigger/t:Repetition', $ns)
    if (-not $repetition) {
      Write-Warning 'Registered task has NO repetition block - the keep-alive is not active.'
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
  } catch {
    Write-Warning "Could not verify the repetition setting (the task WAS registered): $_"
  }
}

Write-Host ''
Write-Host 'Done. The task will start the worker at logon and re-check every'
Write-Host "$RepeatMinutes minutes. It does NOT start it now - run the task manually or"
Write-Host 'log off and on:'
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
