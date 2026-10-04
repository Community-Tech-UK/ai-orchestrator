// Every exec_on_node refusal uses this text, so it states the allowlist rather
// than implying each refused command was a browser launch.
export const NODE_EXEC_BROWSER_POLICY_ERROR =
  'exec_on_node refused this command. It only runs curl with an https:// URL and PowerShell '
  + 'that writes literal text (Write-Output, Write-Host, Write-Error, Write-Verbose, Write-Warning, exit N), so it can never '
  + 'launch or drive the operator\'s shared Chrome/session. Use run_on_node for anything else, '
  + 'including diagnostics such as tasklist, nvidia-smi or Get-CimInstance.';

export function normalizedCommandBasename(value: string): string {
  return value.replace(/\\/gu, '/').split('/').at(-1)?.toLowerCase() ?? '';
}
