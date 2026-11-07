import * as os from 'os';
import * as path from 'path';

/** Same label as the hand-made agent on the CT test Mac, so installing replaces it. */
export const WORKER_LAUNCH_AGENT_LABEL = 'com.aiorchestrator.worker.user';

export interface LaunchAgentPlistOptions {
  programArguments: string[];
  workingDirectory: string;
  path: string;
  logDir: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function launchAgentPlistPath(homedir: string = os.homedir()): string {
  return path.join(homedir, 'Library', 'LaunchAgents', `${WORKER_LAUNCH_AGENT_LABEL}.plist`);
}

/**
 * A per-user LaunchAgent for the worker. Unlike the system LaunchDaemon it runs
 * in the logged-in session (`Aqua`), so the worker can show Chrome, ask for
 * Local Network access, and use the login keychain for signing and the AI
 * tools' sign-ins. A failed exit restarts it, throttled to 30 seconds.
 */
export function generateLaunchAgentPlist(opts: LaunchAgentPlistOptions): string {
  const args = opts.programArguments.map((a) => `    <string>${esc(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WORKER_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(opts.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(opts.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${esc(path.join(opts.logDir, 'launchagent.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(path.join(opts.logDir, 'launchagent.err.log'))}</string>
</dict>
</plist>
`;
}
