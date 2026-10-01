import { app } from 'electron';
import { installFatalTrapSignalGuard } from './app/fatal-trap-signal-guard';
import { writeStartupSmokePidMarker } from './app/startup-smoke-markers';
import { startHarnessMainProcess } from './main-process-bootstrap';

// Must run before ./index loads electron-store (→ when-exit), whose SIGTRAP
// listener turns a Chromium fatal error into an unkillable 100% CPU hang.
installFatalTrapSignalGuard();

void startHarnessMainProcess({
  app,
  argv: process.argv,
  loadMain: () => {
    // Only the process that actually runs main reaches this point (the
    // bootstrap relaunches first), so this is the pid the smoke must track.
    writeStartupSmokePidMarker({ isPackaged: app.isPackaged, env: process.env, pid: process.pid });
    return import('./index');
  },
}).catch((error: unknown) => {
  // Intentional console.error: bootstrap failed before the structured logger
  // (initialized inside startHarnessMainProcess/index) could be relied upon.
  console.error('Harness main-process bootstrap failed', error);
  app.exit(1);
});
