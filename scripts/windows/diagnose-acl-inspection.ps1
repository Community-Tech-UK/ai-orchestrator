# ---------------------------------------------------------------------------
# Does the worker's ACL-inspection script actually PARSE?
#
# buildWindowsAclInspectionScript() in
# src/worker-agent/worker-node-command-resolver.ts joins its lines with ';'.
# One of those lines is '[pscustomobject]@{', so the joined text contains
# "@{;daclPresent=..." - a leading semicolon inside a hash literal. If that is
# a parse error, every exec_on_node call on Windows dies in inspectWindowsAcl's
# catch-all as "trusted Windows ACL inspection failed or was unavailable",
# regardless of timing.
#
# This runs the CURRENT (semicolon-joined) text and a PROPOSED
# (newline-joined) text and reports exit code + JSON validity for each.
#
# Windows PowerShell 5.1 compatible: uses the call operator, NOT
# ProcessStartInfo.ArgumentList (that property is .NET Core only and is $null
# on 5.1 - an earlier revision of this script tripped over exactly that).
#
# Read-only: Get-Acl only. Keep this file pure ASCII.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'

$systemRoot = $env:SystemRoot
if (-not $systemRoot) { $systemRoot = 'C:\Windows' }
$ps     = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$parent = Split-Path -Parent $ps
$q      = "'"

# Exactly the element list buildWindowsAclInspectionScript() produces.
$lines = @(
  "`$ErrorActionPreference='Stop'",
  ("`$paths=@({0}{1}{0},{0}{2}{0})" -f $q, $ps, $parent),
  '$records=@(foreach($path in $paths){',
  '$acl=Get-Acl -LiteralPath $path',
  '$raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)',
  '[pscustomobject]@{',
  'daclPresent=(($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0)',
  'daclNull=($null -eq $raw.DiscretionaryAcl)',
  'path=$path',
  'ownerSid=($acl.GetOwner([System.Security.Principal.SecurityIdentifier])).Value',
  'rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object{',
  '[pscustomobject]@{appliesToObject=(($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0);sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=([int64]$_.FileSystemRights -band 0xffffffffL)}',
  '})',
  '}',
  '})',
  'ConvertTo-Json -InputObject $records -Compress -Depth 5'
)

$current  = $lines -join ';'
$proposed = $lines -join "`n"

Write-Host ('PSVersion: {0}' -f $PSVersionTable.PSVersion.ToString())
Write-Host ''

function Test-Variant {
    param([string]$Label, [string]$Script)

    $errFile = Join-Path $env:TEMP ('aio-acl-{0}.err' -f ([guid]::NewGuid().ToString('N')))
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $raw = & $ps -NoLogo -NoProfile -NonInteractive -Command $Script 2>$errFile
    $code = $LASTEXITCODE
    $sw.Stop()

    $out = ($raw | Out-String).Trim()
    $err = ''
    if (Test-Path -LiteralPath $errFile) {
        $err = (Get-Content -Raw -LiteralPath $errFile -ErrorAction SilentlyContinue)
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }

    Write-Host ('--- {0} ---' -f $Label)
    Write-Host ('  elapsed : {0} ms (worker budget 1000)' -f $sw.ElapsedMilliseconds)
    Write-Host ('  exitCode: {0}' -f $code)
    Write-Host ('  stdout  : {0} chars' -f $out.Length)
    if ($err -and $err.Trim()) {
        $firstErr = (($err.Trim()) -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 2) -join ' | '
        Write-Host ('  stderr  : {0}' -f $firstErr)
    } else {
        Write-Host '  stderr  : (none)'
    }
    if (-not $out) {
        Write-Host '  JSON    : NO OUTPUT -> inspectWindowsAcl rejects this'
    } else {
        try {
            $parsed = $out | ConvertFrom-Json
            Write-Host ('  JSON    : OK, {0} record(s)' -f @($parsed).Count)
            foreach ($r in @($parsed)) {
                Write-Host ('            {0}' -f $r.path)
                Write-Host ('              daclPresent={0} daclNull={1} rules={2}' -f `
                    $r.daclPresent, $r.daclNull, @($r.rules).Count)
            }
        } catch {
            Write-Host ('  JSON    : PARSE FAILED -> {0}' -f $_.Exception.Message)
        }
    }
    Write-Host ''
}

Write-Host '=========================================================='
Write-Host '  ACL inspection script: current join vs proposed join'
Write-Host '=========================================================='
Write-Host ''

Test-Variant -Label 'CURRENT  (semicolon join - ships today)' -Script $current
Test-Variant -Label 'PROPOSED (newline join)' -Script $proposed

Write-Host '=========================================================='
Write-Host '  CURRENT failing + PROPOSED returning 2 records means the'
Write-Host '  join separator is the entire bug.'
Write-Host '=========================================================='
exit 0
