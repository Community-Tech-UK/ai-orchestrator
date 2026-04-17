export interface SystemdUnitOptions {
  description: string;
  execStart: string;
  user: string;
  group: string;
  workingDirectory: string;
  stateDirectory: string;
  logDirectory: string;
  environment?: Record<string, string>;
}

export function generateSystemdUnit(opts: SystemdUnitOptions): string {
  const envLines = opts.environment
    ? Object.entries(opts.environment).map(([k, v]) => `Environment=${k}=${v}`).join('\n')
    : '';
  return `[Unit]
Description=${opts.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${opts.user}
Group=${opts.group}
WorkingDirectory=${opts.workingDirectory}
ExecStart=${opts.execStart}
Restart=on-failure
RestartSec=10
StateDirectory=${opts.stateDirectory}
LogsDirectory=${opts.logDirectory}
${envLines}

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
ReadOnlyPaths=/etc/orchestrator
ReadWritePaths=/var/log/orchestrator /var/lib/orchestrator

[Install]
WantedBy=multi-user.target
`;
}
