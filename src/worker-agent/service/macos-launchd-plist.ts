export interface LaunchdPlistOptions {
  label: string;
  programArguments: string[];
  userName: string;
  groupName: string;
  stdoutPath: string;
  stderrPath: string;
  workingDirectory: string;
  environment?: Record<string, string>;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function generateLaunchdPlist(opts: LaunchdPlistOptions): string {
  const args = opts.programArguments.map((a) => `    <string>${esc(a)}</string>`).join('\n');
  const envEntries = opts.environment
    ? Object.entries(opts.environment)
        .map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
        .join('\n')
    : '';
  const envBlock = envEntries
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>UserName</key>
  <string>${esc(opts.userName)}</string>
  <key>GroupName</key>
  <string>${esc(opts.groupName)}</string>
  <key>WorkingDirectory</key>
  <string>${esc(opts.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${esc(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(opts.stderrPath)}</string>
  <key>ProcessType</key>
  <string>Background</string>
${envBlock}</dict>
</plist>
`;
}
