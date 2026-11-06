/**
 * The native call and lease clock run together on one helper thread. The helper
 * releases even if the worker's event loop stalls, its pipe closes, or it dies.
 * Only renewal bytes cross stdin; no user input is evaluated as PowerShell.
 */
export const WINDOWS_KEEP_AWAKE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
public static class HarnessPowerLease {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint SetThreadExecutionState(uint flags);
  public static void Run() {
    if (SetThreadExecutionState(0x80000001) == 0)
      throw new InvalidOperationException("Cannot prevent system sleep");
    try {
      Console.WriteLine("READY"); Console.Out.Flush();
      Stream input = Console.OpenStandardInput();
      byte[] buffer = new byte[1];
      var read = input.ReadAsync(buffer, 0, 1);
      var clock = Stopwatch.StartNew();
      while (clock.ElapsedMilliseconds < 90000) {
        if (!read.Wait(1000)) continue;
        if (read.Result == 0) break;
        clock.Restart();
        read = input.ReadAsync(buffer, 0, 1);
      }
    } finally { SetThreadExecutionState(0x80000000); }
  }
}
'@
[HarnessPowerLease]::Run()
`;
