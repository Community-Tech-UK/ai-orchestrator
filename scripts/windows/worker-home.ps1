# Installed worker state is separate for each checkout. Provider sign-ins stay shared.
function Get-AioWorkerInstall {
  param([string]$RepoPath, [string]$ScriptPath, [string]$WorkerHome)
  if (-not $RepoPath) {
    $scriptFolder = Split-Path -Parent $ScriptPath
    $installed = Join-Path $scriptFolder 'worker-install.json'
    if (Test-Path -LiteralPath $installed) {
      $RepoPath = (Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json).repoPath
    } else {
      $RepoPath = [IO.Path]::GetFullPath((Join-Path $scriptFolder '..\..'))
    }
  }
  $RepoPath = [IO.Path]::GetFullPath($RepoPath).TrimEnd('\')
  if (-not (Test-Path -LiteralPath (Join-Path $RepoPath 'start-worker.bat'))) {
    throw 'Run this script from its owning checkout or installed worker home. A detached Desktop copy cannot identify which worker to change.'
  }
  $explicitHome = -not [string]::IsNullOrWhiteSpace($WorkerHome)
  if (-not $explicitHome) { $workerHome = Join-Path $env:USERPROFILE '.orchestrator' }
  $marker = Join-Path $RepoPath '.aio-worker-home'
  if (-not $explicitHome -and (Test-Path -LiteralPath $marker)) {
    $workerHome = [IO.File]::ReadAllText($marker).Trim([char]0xFEFF).Trim()
    if (-not [IO.Path]::IsPathRooted($workerHome) -or $workerHome -match '[\r\n]') {
      throw 'The worker home marker must contain one absolute folder path.'
    }
  }
  $workerHome = [IO.Path]::GetFullPath($workerHome).TrimEnd('\')
  $taskName = Get-AioWorkerTaskName -WorkerHome $workerHome
  $updateTaskName = "$taskName Update"
  $metadata = Join-Path $workerHome 'worker-install.json'
  if (Test-Path -LiteralPath $metadata) {
    $installed = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
    if (-not $installed.repoPath.Equals($RepoPath, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'This worker home belongs to a different checkout. Choose a separate worker home.'
    }
    $taskName = $installed.taskName
    $updateTaskName = $installed.updateTaskName
  }
  return @{ RepoPath = $RepoPath; Home = $workerHome; TaskName = $taskName; UpdateTaskName = $updateTaskName }
}

function Get-AioWorkerTaskName {
  param([string]$WorkerHome)
  $defaultHome = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.orchestrator')).TrimEnd('\')
  $resolved = [IO.Path]::GetFullPath($WorkerHome).TrimEnd('\')
  if ($resolved.Equals($defaultHome, [StringComparison]::OrdinalIgnoreCase)) { return 'AI Orchestrator Worker' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($resolved.ToLowerInvariant()))
    $suffix = ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant().Substring(0, 8)
  } finally { $sha.Dispose() }
  return "AI Orchestrator Worker $suffix"
}
