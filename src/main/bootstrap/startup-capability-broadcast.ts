import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { sendValidatedRendererEvent } from '../event-bus/renderer-event-validation';
import type { StartupCapabilityReport } from '../../shared/types/startup-capability.types';

/**
 * Pushes a freshly probed startup-capability report to every open window.
 *
 * The title-bar status chip and the "Startup Checks: Degraded" banner are fed
 * by the `app:startup-capabilities` event, which was previously only emitted
 * once at `app:ready`. Without this broadcast a Doctor re-probe would clear the
 * Doctor panel but leave the banner stuck on the boot-time result until the
 * app was restarted.
 */
export function broadcastStartupCapabilities(report: StartupCapabilityReport): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      sendValidatedRendererEvent(
        win.webContents,
        IPC_CHANNELS.APP_STARTUP_CAPABILITIES,
        report,
      );
    }
  } catch {
    // Not in an Electron context (tests) — the report is still returned to the
    // caller, so a failed broadcast must never sink the Doctor report.
  }
}
