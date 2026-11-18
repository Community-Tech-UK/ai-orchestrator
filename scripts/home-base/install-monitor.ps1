[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Enable,
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
)

$ErrorActionPreference = 'Stop'
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$directory = Join-Path $localAppData 'Harness\home-base-monitor'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$owner = $identity.Name
$taskName = 'HarnessHomeBaseMonitor-' + $identity.User.Value
$configPath = Join-Path $directory 'monitor.json'
$systemSid = 'S-1-5-18'

if ($owner -ine "$([Environment]::MachineName)\HarnessMonitor" -or $identity.Groups.Value -contains 'S-1-5-32-544') {
  throw 'Sign into the separate standard HarnessMonitor account before installing the monitor.'
}

if (-not [IO.Path]::IsPathRooted($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw 'NodePath must name the installed Windows node.exe by its full path.'
}

function Assert-PrivateTree([System.IO.FileSystemInfo]$entry) {
  if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'The monitor folder cannot contain linked files or directories.'
  }
  $existingAcl = Get-Acl -LiteralPath $entry.FullName
  $trustedSids = @($identity.User.Value, $systemSid)
  $entryOwner = $existingAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($entryOwner -notin $trustedSids) { throw 'The monitor folder contains a file that belongs to another account.' }
  if ($entry.FullName -eq $directory -and -not $existingAcl.AreAccessRulesProtected) {
    throw 'The existing monitor folder inherits permissions. Prepare a private monitor folder before proceeding.'
  }
  $rules = $existingAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if (@($rules | Where-Object { $_.IdentityReference.Value -notin $trustedSids }).Count) {
    throw 'The monitor folder is accessible to another account. Inspect its permissions before proceeding.'
  }
  if ($entry.PSIsContainer) {
    Get-ChildItem -LiteralPath $entry.FullName -Force | ForEach-Object { Assert-PrivateTree $_ }
  }
}

if ($PSCmdlet.ShouldProcess($directory, 'Install home-base monitor files with access restricted to this account and SYSTEM')) {
  foreach ($parent in @($localAppData, (Split-Path $directory))) {
    $item = Get-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue
    if ($item -and (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
      throw 'The monitor parent folder cannot be a link.'
    }
  }
  $existingDirectory = Get-Item -LiteralPath $directory -Force -ErrorAction SilentlyContinue
  if ($existingDirectory) {
    if (-not $existingDirectory.PSIsContainer) { throw 'The monitor folder path is occupied by a file.' }
    Assert-PrivateTree $existingDirectory
    $checkLinks = @'
const fs = require('node:fs');
const path = require('node:path');
function check(file) {
  const stat = fs.lstatSync(file);
  if (stat.isDirectory()) for (const child of fs.readdirSync(file)) check(path.join(file, child));
  else if (!stat.isFile() || stat.nlink !== 1) process.exit(1);
}
check(process.argv[1]);
'@
    & $NodePath -e $checkLinks -- $directory
    if ($LASTEXITCODE -ne 0) { throw 'The monitor folder cannot contain linked or special files.' }
  }
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($identity.User, [System.Security.Principal.SecurityIdentifier]::new($systemSid))) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', $inheritance, $propagation, $allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $directory -AclObject $acl
  foreach ($name in @('monitor.js', 'monitor-core.js', 'monitor-mail.js')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $directory $name) -Force
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
