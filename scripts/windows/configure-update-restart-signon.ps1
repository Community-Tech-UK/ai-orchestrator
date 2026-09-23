<#
.SYNOPSIS
  Make a Windows Update restart bring the worker back without anyone logging in.

.DESCRIPTION
  The worker runs in the interactive session on purpose (it drives Chrome and the
  Android emulator), so its scheduled task starts it at LOGON. A Windows Update
  restart therefore leaves the node offline until someone signs in: on
  2026-09-18 windows-pc was restarted by TrustedInstaller at 23:40 and the worker
  only returned at the next logon, about 25 minutes later.

  Windows can finish an update restart by signing the user back in and locking
  the session ("Use my sign-in info to automatically finish setting up after an
  update", Automatic Restart Sign-On / ARSO). With it on, the logon trigger fires
  after an update restart and the worker comes back unattended, while the desktop
  stays locked.

  Scope and limits, stated plainly:
    - ARSO only covers restarts that Windows Update initiates. A power cut or a
      manual restart still waits at the sign-in screen.
    - A Group Policy (DisableAutomaticRestartSignOn) overrides the per-user
      setting; this script reports that and does not fight it.
    - Active hours (optional) only move WHEN Windows restarts; they cannot stop
      it restarting.

  Without -Apply this only reports the current state. Changing it needs an
  ELEVATED PowerShell. Elevating can sign you into a different admin account, so
  name the worker account with -WorkerUser; the script targets that account's
  SID, not whoever is running it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\configure-update-restart-signon.ps1 -WorkerUser '9950X3D\shutu'

.EXAMPLE
  # Elevated:
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\configure-update-restart-signon.ps1 -WorkerUser '9950X3D\shutu' -Apply -ActiveHoursStart 8 -ActiveHoursEnd 2

  Keep this file pure ASCII.
#>
[CmdletBinding()]
param(
  [string]$WorkerUser = "$env:USERDOMAIN\$env:USERNAME",

  [switch]$Apply,

  # Optional active hours (0-23). Windows allows a window of at most 18 hours
  # and it may wrap past midnight (e.g. 8 -> 2).
  [ValidateRange(0, 23)]
  [int]$ActiveHoursStart = -1,

  [ValidateRange(0, 23)]
  [int]$ActiveHoursEnd = -1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$policyKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$arsoRoot = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\UserARSO'
$uxKey = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'

function Get-RegValue {
  param([string]$Key, [string]$Name)
  $item = Get-ItemProperty -Path $Key -ErrorAction SilentlyContinue
  if (-not $item -or -not $item.PSObject.Properties[$Name]) { return $null }
  return $item.$Name
}

try {
  $sid = (New-Object Security.Principal.NTAccount($WorkerUser)).Translate(
    [Security.Principal.SecurityIdentifier]).Value
} catch {
  throw "Could not resolve '$WorkerUser' to a SID. Pass the worker account as -WorkerUser 'MACHINE\user'."
}
$arsoKey = Join-Path $arsoRoot $sid

$policy = Get-RegValue -Key $policyKey -Name 'DisableAutomaticRestartSignOn'
$optOut = Get-RegValue -Key $arsoKey -Name 'OptOut'
$ahStart = Get-RegValue -Key $uxKey -Name 'ActiveHoursStart'
$ahEnd = Get-RegValue -Key $uxKey -Name 'ActiveHoursEnd'
$smart = Get-RegValue -Key $uxKey -Name 'SmartActiveHoursState'

$arsoState = if ($policy -eq 1) { 'DISABLED by policy (DisableAutomaticRestartSignOn=1)' }
             elseif ($optOut -eq 0) { 'ON' }
             elseif ($optOut -eq 1) { 'OFF (user opted out)' }
             else { 'not set (Windows default for this edition)' }

Write-Host "Worker account      : $WorkerUser ($sid)"
Write-Host "Update sign-in ARSO : $arsoState"
Write-Host ("Active hours        : {0}" -f $(if ($null -ne $ahStart -and $null -ne $ahEnd) { "$($ahStart):00 -> $($ahEnd):00" } else { 'not set' }))
Write-Host ("Smart active hours  : {0}" -f $(if ($smart -eq 1) { 'on' } elseif ($null -eq $smart) { 'not set' } else { 'off' }))

if (-not $Apply) {
  Write-Host ''
  Write-Host 'Report only. Re-run from an ELEVATED PowerShell with -Apply to change it.'
  exit 0
}

$isElevated = (New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isElevated) {
  throw 'Changing these settings needs an ELEVATED PowerShell (they live under HKLM).'
}

if ($policy -eq 1) {
  Write-Warning 'A policy disables automatic restart sign-on for every user; the per-user setting would have no effect. Not changing it.'
} else {
  if (-not (Test-Path -LiteralPath $arsoKey)) { New-Item -Path $arsoKey -Force | Out-Null }
  New-ItemProperty -Path $arsoKey -Name 'OptOut' -PropertyType DWord -Value 0 -Force | Out-Null
  Write-Host "Turned ON 'Use my sign-in info to automatically finish setting up after an update' for $WorkerUser."
}

if ($ActiveHoursStart -ge 0 -or $ActiveHoursEnd -ge 0) {
  if ($ActiveHoursStart -lt 0 -or $ActiveHoursEnd -lt 0) {
    throw 'Give both -ActiveHoursStart and -ActiveHoursEnd, or neither.'
  }
  $span = ($ActiveHoursEnd - $ActiveHoursStart + 24) % 24
  if ($span -eq 0 -or $span -gt 18) {
    throw "Active hours must span 1-18 hours; $ActiveHoursStart -> $ActiveHoursEnd spans $span."
  }
  if (-not (Test-Path -LiteralPath $uxKey)) { New-Item -Path $uxKey -Force | Out-Null }
  New-ItemProperty -Path $uxKey -Name 'ActiveHoursStart' -PropertyType DWord -Value $ActiveHoursStart -Force | Out-Null
  New-ItemProperty -Path $uxKey -Name 'ActiveHoursEnd' -PropertyType DWord -Value $ActiveHoursEnd -Force | Out-Null
  # Smart active hours would overwrite a manual window with its own guess.
  New-ItemProperty -Path $uxKey -Name 'SmartActiveHoursState' -PropertyType DWord -Value 0 -Force | Out-Null
  Write-Host "Active hours set to $($ActiveHoursStart):00 -> $($ActiveHoursEnd):00 (smart active hours off)."
}

Write-Host 'Done. Confirm in Settings > Accounts > Sign-in options, and Settings > Windows Update > Advanced options.'
