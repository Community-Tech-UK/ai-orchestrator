param([Parameter(Mandatory = $true)][string]$RepoPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'worker-home.ps1')
$installation = Get-AioWorkerInstall -RepoPath $RepoPath
Write-Output $installation.Home
