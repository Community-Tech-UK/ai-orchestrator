[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,

  [string]$NodeExe = '',

  [string]$StartupLauncherName = 'HarnessWorker.vbs',

  [bool]$Relaunch = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NodeExeFromCommandLine {
  param([string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return '' }
  if ($CommandLine -match '^\s*"([^"]*node\.exe)"') { return $Matches[1] }
  if ($CommandLine -match '^\s*([^\s]+node\.exe)') { return $Matches[1] }
  return ''
}

function Resolve-NodeExe {
  param([string]$RequestedNodeExe, [array]$WorkerProcesses)

  if (-not [string]::IsNullOrWhiteSpace($RequestedNodeExe)) {
    if (-not (Test-Path -LiteralPath $RequestedNodeExe -PathType Leaf)) {
      throw "NodeExe does not exist: $RequestedNodeExe"
    }
    return (Resolve-Path -LiteralPath $RequestedNodeExe).Path
  }

  foreach ($proc in $WorkerProcesses) {
    $candidate = Get-NodeExeFromCommandLine -CommandLine $proc.CommandLine
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  $pathNode = Get-Command node -ErrorAction SilentlyContinue
  if ($pathNode -and (Test-Path -LiteralPath $pathNode.Source -PathType Leaf)) {
    return $pathNode.Source
  }

  throw 'Could not resolve node.exe. Pass -NodeExe explicitly.'
}

function Backup-AndWriteLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content,
    [Parameter(Mandatory = $true)][string]$Stamp
  )

  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  if (Test-Path -LiteralPath $Path) {
    $backup = "$Path.bak-$Stamp"
    Copy-Item -LiteralPath $Path -Destination $backup -Force
    Write-Host "Backed up $Path to $backup"
  }

  Set-Content -LiteralPath $Path -Value $Content -Encoding ASCII
  Write-Host "Wrote $Path"
}

$repo = (Resolve-Path -LiteralPath $RepoPath).Path
if ($repo -match '\\OneDrive\\') {
  throw "Refusing to use a OneDrive repo path: $repo"
}

$idx = Join-Path $repo 'dist\worker-agent\index.js'
if (-not (Test-Path -LiteralPath $idx -PathType Leaf)) {
  throw "No worker build found at $idx. Build the worker at the new path first, then rerun."
}

$procs = @(
  Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -like '*worker-agent*index.js*' }
)
$resolvedNodeExe = Resolve-NodeExe -RequestedNodeExe $NodeExe -WorkerProcesses $procs

$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$startup = Join-Path $startupDir $StartupLauncherName
$src = Join-Path $env:USERPROFILE '.orchestrator\run-worker-hidden.vbs'
$srcDir = Split-Path -Parent $src

$vbs = @"
Set sh = CreateObject("Wscript.Shell")
sh.Run """$resolvedNodeExe"" ""$idx""", 0, False
"@

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Backup-AndWriteLauncher -Path $startup -Content $vbs -Stamp $stamp
if (Test-Path -LiteralPath $srcDir) {
  Backup-AndWriteLauncher -Path $src -Content $vbs -Stamp $stamp
} else {
  Write-Host "Skipped source launcher because folder does not exist: $srcDir"
}

if ($procs.Count -gt 0) {
  foreach ($proc in $procs) {
    Write-Host "Killing worker PID $($proc.ProcessId)"
    Stop-Process -Id $proc.ProcessId -Force
  }
} else {
  Write-Host 'No running worker found.'
}

if ($Relaunch) {
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) {
    $wscript = 'wscript.exe'
  }
  Write-Host "Relaunching worker with $startup"
  Start-Process -FilePath $wscript -ArgumentList "`"$startup`""
}

Write-Host "DONE. Worker launcher now points at $idx"
