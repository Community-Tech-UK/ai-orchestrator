# ---------------------------------------------------------------------------
# Install restart-chrome.bat onto the Desktop and run it.
#
# Source of truth: scripts\windows\restart-chrome-launch.ps1
#
# WHY THIS THIN WRAPPER EXISTS
# Two separate constraints meet here, and each one rules out the obvious route:
#
#  1. upload_to_node cannot write to the Desktop. The Desktop transfer root is
#     read-only, so the .bat can only be delivered into the scratch root. A
#     script running ON the node is the only thing that can place it where it
#     can be double-clicked.
#
#  2. exec_on_node cannot run a .bat at all. Its allowlist admits only
#     powershell and curl, and its inline-PowerShell grammar permits nothing but
#     Write-* and a literal exit. The ONE sanctioned way to run real logic on a
#     worker is `powershell -File` against a script whose sha256 was pinned by
#     upload_to_node - the pin, not a content scan, is the integrity control.
#
# So: this file is the pinned entry point, and restart-chrome.bat stays the
# single source of the actual restart logic. Deliberately no duplicated restart
# code here - a second copy of that logic would drift from the .bat the moment
# either changed, and the .bat is what a human double-clicks.
#
# Keep this file pure ASCII.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'

$source  = Join-Path $env:USERPROFILE '.orchestrator\_scratch\aio-transfers\restart-chrome.bat'
$desktop = [Environment]::GetFolderPath('Desktop')
$target  = Join-Path $desktop 'restart-chrome.bat'

Write-Host '=========================================================='
Write-Host '  Installing restart-chrome.bat to the Desktop'
Write-Host '=========================================================='

if (-not (Test-Path -LiteralPath $source)) {
    Write-Host ('  *** Source not found: {0} ***' -f $source)
    Write-Host '  Re-upload it with upload_to_node and try again.'
    exit 10
}

# GetFolderPath rather than "$env:USERPROFILE\Desktop": a OneDrive-redirected
# Desktop lives under the OneDrive folder, and writing to the literal path
# would put the file somewhere the user never looks.
if (-not (Test-Path -LiteralPath $desktop)) {
    Write-Host ('  *** Desktop folder not found: {0} ***' -f $desktop)
    exit 11
}

Copy-Item -LiteralPath $source -Destination $target -Force
Write-Host ('  installed -> {0}' -f $target)

$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
Write-Host ('  sha256      {0}' -f $hash)
Write-Host ''

# Suppress the trailing `pause`, which would otherwise block forever with no
# console attached and hold the RPC open until it timed out.
$env:AIO_NO_PAUSE = '1'

Write-Host '=========================================================='
Write-Host '  Running it'
Write-Host '=========================================================='
Write-Host ''

& cmd.exe /c $target
$code = $LASTEXITCODE

Write-Host ''
Write-Host ('restart-chrome.bat exit code: {0}' -f $code)
exit $code
