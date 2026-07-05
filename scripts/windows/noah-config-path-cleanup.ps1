[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OldPath,

  [Parameter(Mandatory = $true)]
  [string]$NewPath,

  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-NotOneDrivePath {
  param([string]$PathValue, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return
  }

  $normalized = $PathValue -replace '/', '\'
  if ($normalized -match '(?i)(^|\\)OneDrive(?:\s+-\s+[^\\]+)?($|\\)') {
    throw "$Label must not be under OneDrive: $PathValue"
  }
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Backup-File {
  param([string]$Path)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = "$Path.bak-$stamp"
  Copy-Item -LiteralPath $Path -Destination $backup -Force
  Write-Host "Backed up $Path to $backup"
}

function ConvertTo-EscapedWindowsPath {
  param([string]$PathValue)
  return $PathValue.Replace('\', '\\')
}

function Get-PathMatchVariants {
  param([string]$PathValue)
  $variants = New-Object System.Collections.Generic.List[string]
  $variants.Add($PathValue)
  $escaped = ConvertTo-EscapedWindowsPath -PathValue $PathValue
  if ($escaped -ne $PathValue) {
    $variants.Add($escaped)
  }
  return $variants.ToArray()
}

function Get-PathMatchLineNumbers {
  param([string]$Path, [string[]]$Needles)
  $lineNumbers = New-Object System.Collections.Generic.List[int]
  foreach ($needle in $Needles) {
    if ([string]::IsNullOrWhiteSpace($needle)) {
      continue
    }
    Select-String -LiteralPath $Path -SimpleMatch $needle |
      ForEach-Object { $lineNumbers.Add($_.LineNumber) }
  }
  return $lineNumbers | Sort-Object -Unique
}

function Replace-PathVariants {
  param([string]$Text, [string]$OldValue, [string]$NewValue)
  $updated = $Text.Replace($OldValue, $NewValue)
  $oldEscaped = ConvertTo-EscapedWindowsPath -PathValue $OldValue
  $newEscaped = ConvertTo-EscapedWindowsPath -PathValue $NewValue
  if ($oldEscaped -ne $OldValue) {
    $updated = $updated.Replace($oldEscaped, $newEscaped)
  }
  return $updated
}

function Get-CodexProjectHeaders {
  param([string]$ProjectPath)
  $escapedPath = ConvertTo-EscapedWindowsPath -PathValue $ProjectPath
  return @(
    "[projects.'$ProjectPath']",
    "[projects.`"$escapedPath`"]"
  )
}

function Remove-TomlTableBlock {
  param([string[]]$Lines, [string[]]$Headers)
  $out = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  foreach ($line in $Lines) {
    if ($Headers -contains $line.Trim()) {
      $skipping = $true
      continue
    }
    if ($skipping -and $line -match '^\s*\[') {
      $skipping = $false
    }
    if (-not $skipping) {
      $out.Add($line)
    }
  }
  return $out.ToArray()
}

function Update-CodexConfig {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Host "missing $Path"
    return
  }

  $lineNumbers = @(Get-PathMatchLineNumbers -Path $Path -Needles (Get-PathMatchVariants -PathValue $OldPath))
  if ($lineNumbers.Count -eq 0) {
    Write-Host "no old path matches in $Path"
    return
  }

  Write-Host "old path appears in $Path at line(s): $($lineNumbers -join ', ')"
  if (-not $Apply) {
    return
  }

  Backup-File -Path $Path
  $lines = [System.IO.File]::ReadAllLines($Path)
  $oldHeaders = Get-CodexProjectHeaders -ProjectPath $OldPath
  $newHeaders = Get-CodexProjectHeaders -ProjectPath $NewPath
  $hasNewHeader = $lines | Where-Object { $newHeaders -contains $_.Trim() } | Select-Object -First 1
  if ($hasNewHeader) {
    $updatedLines = Remove-TomlTableBlock -Lines $lines -Headers $oldHeaders |
      ForEach-Object { Replace-PathVariants -Text $_ -OldValue $OldPath -NewValue $NewPath }
    Write-Host "Removed duplicate old Codex project block because the new block already exists; repointed remaining references."
  } else {
    $updatedLines = $lines | ForEach-Object { Replace-PathVariants -Text $_ -OldValue $OldPath -NewValue $NewPath }
    Write-Host "Repointed old Codex path references to the new path."
  }
  Write-Utf8NoBom -Path $Path -Text (($updatedLines -join [Environment]::NewLine) + [Environment]::NewLine)
}

function Update-ClaudeConfig {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Host "missing $Path"
    return
  }

  $lineNumbers = @(Get-PathMatchLineNumbers -Path $Path -Needles (Get-PathMatchVariants -PathValue $OldPath))
  if ($lineNumbers.Count -eq 0) {
    Write-Host "no old path matches in $Path"
    return
  }

  Write-Host "old path appears in $Path at line(s): $($lineNumbers -join ', ')"
  if (-not $Apply) {
    return
  }

  Backup-File -Path $Path
  $text = [System.IO.File]::ReadAllText($Path)
  Write-Utf8NoBom -Path $Path -Text (Replace-PathVariants -Text $text -OldValue $OldPath -NewValue $NewPath)
  Write-Host "Repointed old Claude path references to the new path."
}

if ($OldPath -eq $NewPath) {
  throw 'OldPath and NewPath are identical.'
}
Assert-NotOneDrivePath -PathValue $NewPath -Label 'NewPath'

Write-Host "Mode: $(if ($Apply) { 'apply' } else { 'scan only' })"
Write-Host 'Secret values are not printed.'
Update-CodexConfig -Path (Join-Path $env:USERPROFILE '.codex\config.toml')
Update-ClaudeConfig -Path (Join-Path $env:USERPROFILE '.claude.json')
