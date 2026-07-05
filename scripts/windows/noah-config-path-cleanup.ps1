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

function Remove-TomlTableBlock {
  param([string[]]$Lines, [string]$Header)
  $out = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  foreach ($line in $Lines) {
    if ($line.Trim() -eq $Header) {
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

  $matches = @(Select-String -LiteralPath $Path -SimpleMatch $OldPath)
  if ($matches.Count -eq 0) {
    Write-Host "no old path matches in $Path"
    return
  }

  Write-Host "old path appears in $Path at line(s): $(($matches | ForEach-Object { $_.LineNumber }) -join ', ')"
  if (-not $Apply) {
    return
  }

  Backup-File -Path $Path
  $lines = [System.IO.File]::ReadAllLines($Path)
  $oldHeader = "[projects.'$OldPath']"
  $newHeader = "[projects.'$NewPath']"
  $hasNewHeader = $lines | Where-Object { $_.Trim() -eq $newHeader } | Select-Object -First 1
  if ($hasNewHeader) {
    $updatedLines = Remove-TomlTableBlock -Lines $lines -Header $oldHeader
    Write-Host "Removed duplicate old Codex project block because the new block already exists."
  } else {
    $updatedLines = $lines | ForEach-Object { $_.Replace($OldPath, $NewPath) }
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

  $matches = @(Select-String -LiteralPath $Path -SimpleMatch $OldPath)
  if ($matches.Count -eq 0) {
    Write-Host "no old path matches in $Path"
    return
  }

  Write-Host "old path appears in $Path at line(s): $(($matches | ForEach-Object { $_.LineNumber }) -join ', ')"
  if (-not $Apply) {
    return
  }

  Backup-File -Path $Path
  $text = [System.IO.File]::ReadAllText($Path)
  Write-Utf8NoBom -Path $Path -Text $text.Replace($OldPath, $NewPath)
  Write-Host "Repointed old Claude path references to the new path."
}

if ($OldPath -eq $NewPath) {
  throw 'OldPath and NewPath are identical.'
}
if ($NewPath -match '\\OneDrive\\') {
  throw "Refusing to repoint to a OneDrive path: $NewPath"
}

Write-Host "Mode: $(if ($Apply) { 'apply' } else { 'scan only' })"
Write-Host 'Secret values are not printed.'
Update-CodexConfig -Path (Join-Path $env:USERPROFILE '.codex\config.toml')
Update-ClaudeConfig -Path (Join-Path $env:USERPROFILE '.claude.json')
