[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Enable,
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
)

$ErrorActionPreference = 'Stop'
$directory = Join-Path $env:LOCALAPPDATA 'Harness\home-base-monitor'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$owner = $identity.Name
$taskName = 'HarnessHomeBaseMonitor-' + $identity.User.Value
$configPath = Join-Path $directory 'monitor.json'

if (-not [IO.Path]::IsPathRooted($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw 'NodePath must name the installed Windows node.exe by its full path.'
}

if ($PSCmdlet.ShouldProcess($directory, 'Install home-base monitor files with access restricted to this account and SYSTEM')) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($owner, 'SYSTEM')) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', $inheritance, $propagation, $allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $directory -AclObject $acl
  foreach ($name in @('monitor.js', 'monitor-core.js')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $directory $name) -Force
  }
  # Existing config/token files must not retain older explicit grants.
  foreach ($file in Get-ChildItem -LiteralPath $directory -File) {
    $fileAcl = New-Object System.Security.AccessControl.FileSecurity
    $fileAcl.SetOwner($identity.User)
    $fileAcl.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($owner, 'SYSTEM')) {
      $fileAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', $allow)))
    }
    Set-Acl -LiteralPath $file.FullName -AclObject $fileAcl
  }
}

if ($Enable -and $PSCmdlet.ShouldProcess($taskName, 'Run the monitor every 15 minutes while this Windows account is signed in')) {
  & $NodePath (Join-Path $directory 'monitor.js') validate --config $configPath
  if ($LASTEXITCODE -ne 0) { throw 'Monitor configuration and pairing must validate before the task can be enabled.' }
  $arguments = '"{0}" check --config "{1}"' -f (Join-Path $directory 'monitor.js'), $configPath
  $action = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments -WorkingDirectory $directory
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
}

if ($WhatIfPreference) {
  Write-Output 'Preview only. No monitor files or scheduled task were changed.'
} else {
  Write-Output 'Home-base monitor files prepared. The task runs only after -Enable succeeds, while its Windows account is signed in.'
}
