# Worker Agent Auto-Start Service Design

**Date:** 2026-04-16
**Status:** Draft
**Reviewers:** Copilot (GPT-5.3), Codex (GPT-5.3) — both verdict: sound-with-changes

## Problem

The worker agent on remote machines (Windows PC, Linux servers, etc.) must be started manually each time the machine reboots. This is friction-heavy and unreliable for always-on orchestration. The worker should install itself as a native OS service that auto-starts on boot, with runtime management from the coordinator UI.

## Goals

1. Worker agent auto-starts on boot without user login (Windows, Linux, macOS)
2. No Node.js dependency on the remote machine (standalone binary)
3. Runtime management (start/stop/restart/status) from coordinator UI via RPC
4. Secure by default: dedicated service account, hardened service config, encrypted token storage
5. Clean install/uninstall lifecycle with config migration from manual-run setup

## Non-Goals

- Remote desktop or full OS control
- Auto-distribution of worker binaries (user copies binary manually for now)
- GUI installer (CLI-only install)

---

## Architecture Overview

```
Coordinator (Mac)
  ┌─────────────┐  ┌──────────────────┐
  │ Orchestrator │  │  Service Mgmt UI │
  │   UI/API     │  │  (start/stop/    │
  │              │  │   status/restart) │
  └──────┬───────┘  └────────┬─────────┘
         │    WebSocket/RPC  │
         ▼                   ▼
Worker Node (Remote)
  ┌─────────────────────────────────┐
  │  orchestrator-worker binary     │
  │  (Node SEA standalone exe)      │
  ├─────────────────────────────────┤
  │  ServiceManager                 │
  │  ├─ WindowsService (WinSW)     │
  │  ├─ LinuxService (systemd)     │
  │  └─ MacosService (launchd)     │
  └─────────────────────────────────┘
  ┌─────────────┐ ┌──────────────────┐
  │ OS Service   │ │ Config/State     │
  │ (SCM/systemd │ │ (ProgramData/    │
  │  /launchd)   │ │  /etc/ /var/)    │
  └──────────────┘ └──────────────────┘
```

---

## 1. Standalone Executable (Node SEA)

### Approach

Use Node.js Single Executable Applications (SEA), built into Node 22+. This is the officially supported approach — no third-party bundler dependency.

### Build Process

1. Existing `build-worker-agent.ts` uses esbuild to produce `dist/worker-agent/index.js` (single bundle) — unchanged.
2. New script `build-worker-agent-sea.ts`:
   - Generates `sea-config.json` pointing at the esbuild bundle
   - Runs `node --experimental-sea-config sea-config.json` to create the SEA blob
   - Copies platform Node binary, injects blob via `postject`
   - Signs binary: `codesign` (macOS), `signtool` (Windows, if cert available)
3. Output: `dist/worker-agent/orchestrator-worker[.exe]`

### Build Scripts

```
npm run build:worker-sea         # current platform
npm run build:worker-sea:win     # Windows .exe
npm run build:worker-sea:linux   # Linux ELF
npm run build:worker-sea:mac     # macOS Mach-O
```

### WinSW Bundling

WinSW.exe (~1MB) is downloaded during the build step and placed alongside the worker binary. On `--install-service`, it is extracted/copied next to the installed binary location.

### SEA Compatibility Notes

- All worker-agent dependencies must be statically bundled (no dynamic `require` at runtime for external packages)
- The existing esbuild step already handles this — `external: ['electron', 'better-sqlite3']` excludes Electron-only deps that the worker doesn't use
- Native addons are not used by the worker agent
- Validate crash diagnostics (stack traces, core dumps) work correctly in SEA mode

---

## 2. Service Manager Abstraction

### Interface

```typescript
// src/worker-agent/service/service-manager.ts

interface ServiceManager {
  install(config: ServiceInstallConfig): Promise<ServiceResult>;
  uninstall(): Promise<ServiceResult>;
  start(): Promise<ServiceResult>;
  stop(): Promise<ServiceResult>;
  restart(): Promise<ServiceResult>;
  status(): Promise<ServiceStatus>;
}

interface ServiceInstallConfig {
  coordinatorUrl: string;
  tokenFile: string;         // path to file containing auth token
  name?: string;              // defaults to hostname
  namespace?: string;         // defaults to 'default'
  executablePath: string;     // path to SEA binary
}

interface ServiceStatus {
  installed: boolean;
  running: boolean;
  autoStart: boolean;
  pid?: number;
  uptime?: number;            // seconds since service started
  serviceAccount: string;
  configPath: string;
  logPath: string;
  version?: string;           // binary version for update tracking
}

type ServiceResult =
  | { ok: true }
  | { ok: false; error: string; code: ServiceErrorCode };

type ServiceErrorCode =
  | 'NOT_ELEVATED'
  | 'ALREADY_INSTALLED'
  | 'NOT_INSTALLED'
  | 'ACCOUNT_CREATE_FAILED'
  | 'PERMISSION_DENIED'
  | 'PLATFORM_ERROR';
```

### Factory

```typescript
// src/worker-agent/service/index.ts

function createServiceManager(): ServiceManager {
  switch (process.platform) {
    case 'win32':  return new WindowsServiceManager();
    case 'linux':  return new LinuxServiceManager();
    case 'darwin': return new MacosServiceManager();
    default:       throw new Error(`Unsupported platform: ${process.platform}`);
  }
}
```

---

## 3. Platform Implementations

### 3.1 Windows (windows-service.ts)

**Service wrapper:** WinSW (Windows Service Wrapper). Single .exe, well-maintained, handles SCM protocol, restart policies, log rotation.

**Install flow:**
1. Check running as Administrator (fail with `NOT_ELEVATED` if not)
2. Create dedicated Windows user `OrchestratorWorker`:
   - Create user via Windows API (using `execFileNoThrow` for all shell commands — no shell injection)
   - Grant `SeServiceLogonRight` via LSA API (PowerShell `Add-Type` with P/Invoke)
   - Set password to never expire
3. Create directory structure:
   - `C:\ProgramData\Orchestrator\config\`
   - `C:\ProgramData\Orchestrator\data\`
   - `C:\ProgramData\Orchestrator\logs\`
   - `C:\ProgramData\Orchestrator\bin\` (versioned binary location)
4. Copy worker binary + WinSW.exe to `bin\`
5. Write WinSW XML config (`OrchestratorWorker.xml`) with:
   - Restart-on-failure (delays: 5s, 10s, 30s)
   - Log rotation (roll-by-size-time, 10MB threshold, 5 files kept)
   - Service account credentials
6. ACL config/data/log directories to `OrchestratorWorker` user
7. Store auth token via DPAPI (encrypted to service account context)
8. Run WinSW install command (via `execFile`)
9. Configure SCM ACL: grant the installing user's SID `SERVICE_START | SERVICE_STOP | SERVICE_QUERY_STATUS` — this enables coordinator RPC to manage the service without elevation
10. Start the service

**Runtime management (no elevation):**
- Start/stop/restart: via WinSW CLI or SCM API — works because SCM ACL was pre-configured in step 9
- Status: Query SCM

### 3.2 Linux (linux-service.ts)

**Install flow:**
1. Check running as root (`process.getuid() === 0`, fail with `NOT_ELEVATED` if not)
2. Create system user via `useradd` (using `execFile`, not `exec`):
   - `useradd --system --no-create-home --shell /usr/sbin/nologin orchestrator-worker`
3. Create directory structure:
   - `/etc/orchestrator/` (config, 0750, root:orchestrator-worker)
   - `/var/lib/orchestrator/` (state, 0750, orchestrator-worker:orchestrator-worker)
   - `/var/log/orchestrator/` (logs, 0750, orchestrator-worker:orchestrator-worker)
   - `/opt/orchestrator/bin/` (binary, 0755)
4. Copy worker binary to `/opt/orchestrator/bin/`
5. Store auth token in `/etc/orchestrator/token` (0600, orchestrator-worker:orchestrator-worker)
   - Note: this is filesystem-protected, not encrypted. Documented as such. For stronger protection, use kernel keyring or libsecret.
6. Write systemd unit file `/etc/systemd/system/orchestrator-worker.service`:
   ```ini
   [Unit]
   Description=AI Orchestrator Worker Node
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=orchestrator-worker
   Group=orchestrator-worker
   ExecStart=/opt/orchestrator/bin/orchestrator-worker --service-run
   Restart=always
   RestartSec=5
   StandardOutput=journal
   StandardError=journal
   SyslogIdentifier=orchestrator-worker

   # Hardening
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   ReadWritePaths=/var/lib/orchestrator /var/log/orchestrator
   ReadOnlyPaths=/etc/orchestrator
   ProtectKernelTunables=true
   ProtectKernelModules=true
   ProtectControlGroups=true
   RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
   RestrictNamespaces=true
   LockPersonality=true
   MemoryDenyWriteExecute=true
   RestrictRealtime=true
   RestrictSUIDSGID=true

   [Install]
   WantedBy=multi-user.target
   ```
7. Reload systemd and enable the service
8. Install polkit rule for privilege delegation:
   Write `/etc/polkit-1/rules.d/50-orchestrator-worker.rules` — allows the installing user's group to manage the specific service unit without sudo.
9. Start the service

**Logging:** Uses journald (`StandardOutput=journal`). Query with `journalctl -u orchestrator-worker`. Log rotation handled by journald config.

### 3.3 macOS (macos-service.ts)

**Install flow:**
1. Check running as root (fail with `NOT_ELEVATED` if not)
2. Create system user via `sysadminctl` (using `execFile`)
3. Create directory structure:
   - `/Library/Application Support/Orchestrator/config/`
   - `/Library/Application Support/Orchestrator/data/`
   - `/Library/Application Support/Orchestrator/logs/`
   - `/Library/Application Support/Orchestrator/bin/`
4. Copy worker binary to `bin/`
5. Store auth token in System keychain:
   - Uses `security add-generic-password` (via `execFile`) targeting System keychain
   - Set ACL to allow only the worker binary to read
6. Write LaunchDaemon plist `/Library/LaunchDaemons/com.orchestrator.worker.plist`:
   - `KeepAlive: true`, `RunAtLoad: true`
   - `UserName: orchestrator-worker`
   - Stdout/stderr paths in logs directory
   - Set ownership: `root:wheel`, permissions: `0644`
7. Load daemon: `launchctl bootstrap system <plist-path>`

**Runtime management:**
- Start: `launchctl kickstart system/com.orchestrator.worker`
- Stop: `launchctl kill SIGTERM system/com.orchestrator.worker`
- Restart: `launchctl kickstart -k system/com.orchestrator.worker`
- Uninstall: `launchctl bootout system/com.orchestrator.worker`

**Privilege delegation:** The installing user is granted sudo access to `launchctl` for the specific service label via a sudoers drop-in file at `/etc/sudoers.d/orchestrator-worker`.

---

## 4. Install CLI

### Token Input (Security)

Tokens are **never** accepted via CLI arguments (visible in process lists, shell history). Instead:

- **Token file:** `--token-file /path/to/token.txt` (file is read then deleted)
- **Interactive prompt:** default when no token method specified (hidden input)
- **Environment variable:** `ORCHESTRATOR_TOKEN=abc123`
- **Stdin pipe:** `--token-stdin` reads from stdin

### CLI Flags

```
--install-service     Install as native OS service (requires admin/sudo)
--uninstall-service   Remove OS service and clean up
--service-status      Print current service status and exit
--service-run         Internal: run in service mode (no console, log to file)
--coordinator <url>   Coordinator WebSocket URL
--token-file <path>   Path to file containing enrollment token
--token-stdin         Read token from stdin
--name <name>         Worker node display name (default: hostname)
--namespace <ns>      Discovery namespace (default: 'default')
--dry-run             Show what would be installed without doing it
```

### Entry Point Changes

Updated `src/worker-agent/index.ts` main() to:
1. Parse CLI args for service commands
2. If `--install-service`: resolve token (file/stdin/prompt/env), call `manager.install()`, exit
3. If `--uninstall-service`: call `manager.uninstall()`, exit
4. If `--service-status`: call `manager.status()`, print JSON, exit
5. Otherwise: normal startup (existing behavior, plus `--service-run` flag for service mode)

---

## 5. RPC Protocol Extensions

### New RPC Methods (Coordinator to Worker)

Added to `COORDINATOR_TO_NODE` in `worker-node-rpc.ts`:

- `service.status` — returns `ServiceStatus`
- `service.restart` — worker restarts itself via service manager
- `service.stop` — worker stops itself (connection will drop)
- `service.uninstall` — worker uninstalls service and stops

### Authorization

Service-control RPC commands require a **separate elevated scope** beyond the normal instance-management token:

- `instance` scope (default): spawn, sendInput, terminate, interrupt, filesystem ops
- `service` scope: service.restart, service.stop, service.uninstall — requires service-admin token

The coordinator stores the service-admin token separately. The UI prompts for confirmation before sending service-control commands.

### Worker-side RPC Handler

In `worker-agent.ts` `handleRpcRequest()`:
- `service.status`: creates ServiceManager, returns status
- `service.restart`: validates service scope, sends ack, then restarts
- `service.stop`: validates service scope, sends ack, then stops
- `service.uninstall`: validates service scope, sends ack, then uninstalls

Note: for restart/stop/uninstall, the worker sends the RPC response *before* performing the action, since the process will exit.

---

## 6. Coordinator UI

### Node Detail Page Changes

Add a "Service" section to the existing node detail view showing:
- Status (Running/Stopped/Not Installed)
- Uptime
- Version
- Service account name
- Action buttons: Restart, Stop, Uninstall

Service status polled via `service.status` RPC on node connect and every 60s. Buttons disabled when node is disconnected. Confirmation dialog before Stop and Uninstall actions with warning that the node will disconnect.

### IPC Additions

New handlers in `remote-node-handlers.ts`:
- `remote-node:service-status` — calls `service.status` RPC on target node
- `remote-node:service-restart` — calls `service.restart` RPC
- `remote-node:service-stop` — calls `service.stop` RPC
- `remote-node:service-uninstall` — calls `service.uninstall` RPC

### Store Updates

New signal in `remote-nodes.store.ts`:
- `serviceStatus: Record<string, ServiceStatus>` keyed by nodeId

---

## 7. Config Migration

When the worker starts in `--service-run` mode, it checks for a legacy config at `~/.orchestrator/worker-node.json`:

- If system config already exists: skip (idempotent)
- If user config exists but system config doesn't: copy (not move) to system path
- Write migration marker file (`.migrated-from`) for rollback reference
- Log the migration

This is rollback-safe because the original user config is preserved.

---

## 8. Update Strategy

### Versioned Binary Directory

Binary installed to a versioned subdirectory with a symlink (Linux/macOS) or junction (Windows):

```
/opt/orchestrator/bin/
  orchestrator-worker          # symlink to current version
  versions/
    1.2.0/orchestrator-worker
    1.1.0/orchestrator-worker  # previous version kept for rollback
```

### Update Flow (Coordinator-Initiated)

1. Coordinator sends new binary to worker via RPC (binary payload or download URL)
2. Worker downloads/receives binary to `versions/<new-version>/`
3. Worker validates binary (checksum, runs `--version` check)
4. Worker atomically swaps symlink to new version
5. Worker restarts service
6. Coordinator waits for reconnect (health check timeout: 30s)
7. If worker doesn't reconnect, coordinator marks update as failed

### Rollback

On startup, if previous shutdown was unclean (e.g. crash immediately after update), worker detects this and rolls back symlink to previous version automatically.

---

## 9. Error Handling

| Scenario | Behavior |
|----------|----------|
| Install without admin/sudo | Exit with clear error: "This command requires Administrator/root privileges" |
| Service already installed | Exit with `ALREADY_INSTALLED`, suggest `--uninstall-service` first |
| Coordinator unreachable during install | Install proceeds (service starts, retries connection via existing reconnect backoff) |
| Service account creation fails | Exit with `ACCOUNT_CREATE_FAILED` and platform-specific remediation steps |
| Token file not found | Exit with error, list accepted token input methods |
| Worker crashes in service mode | Service manager auto-restarts (WinSW: 5s/10s/30s delays; systemd: 5s; launchd: immediate via KeepAlive) |
| Uninstall while instances running | Terminate all instances first, then uninstall. UI warns user. |

---

## 10. File Structure

### New Files

```
src/worker-agent/
  service/
    service-manager.ts          # Interface + types + factory
    windows-service.ts          # WinSW implementation
    linux-service.ts            # systemd implementation
    macos-service.ts            # launchd implementation
    config-migration.ts         # Legacy config migration logic
    privilege-check.ts          # Cross-platform elevation detection
    token-resolver.ts           # stdin/file/env/prompt token input
    __tests__/
      windows-service.spec.ts
      linux-service.spec.ts
      macos-service.spec.ts
      config-migration.spec.ts
      token-resolver.spec.ts

build-worker-agent-sea.ts       # SEA build script

src/renderer/app/features/remote-nodes/
  components/
    node-service-panel/         # New component for service management UI
```

### Modified Files

```
src/worker-agent/index.ts                   # CLI flag parsing, service commands
src/worker-agent/worker-agent.ts            # New RPC handlers for service.*
src/main/remote-node/worker-node-rpc.ts     # New RPC method constants
src/main/ipc/handlers/remote-node-handlers.ts  # New service IPC handlers
src/shared/types/worker-node.types.ts       # ServiceStatus, ServiceResult types
src/shared/validation/ipc-schemas.ts        # New Zod schemas for service IPC
src/preload/preload.ts                      # Expose new service IPC methods
src/renderer/app/features/remote-nodes/
  remote-nodes.store.ts                     # serviceStatus signal
  pages/node-detail/                        # Add service panel
package.json                                # New build scripts
```

---

## 11. Testing Strategy

### Unit Tests
- ServiceManager implementations: mock all shell commands (via `execFile` wrappers), verify correct commands and arguments generated per platform
- Config migration: test idempotency, missing source, existing destination, marker file
- Token resolver: test all input methods (file, stdin, env, prompt)
- Privilege check: mock `process.getuid()` / Windows API responses

### Integration Tests
- Full install/uninstall cycle on each platform (CI matrix: Windows, Ubuntu, macOS)
- Verify service starts on reboot (VM-based test)
- Verify coordinator can query service status via RPC
- Verify config migration from user-home to system path

### Manual Test Checklist
- Windows: Install as admin, verify auto-start after reboot, manage from coordinator
- Windows: Install without admin — verify clean error
- Linux: Install with sudo, verify systemctl status, journald logs
- macOS: Install with sudo, verify launchctl list shows daemon
- Coordinator: Service panel shows status, buttons work
- Update: Push new binary, verify health-gated switchover
- Rollback: Push bad binary, verify auto-rollback

---

## 12. Security Summary

| Aspect | Implementation |
|--------|---------------|
| **Service account** | Dedicated low-privilege user per platform (not LocalSystem/root) |
| **Token at rest** | DPAPI (Windows), System Keychain (macOS), 0600 file (Linux, documented as filesystem-protected) |
| **Token input** | stdin, file (deleted after read), env var, interactive prompt — never CLI args |
| **Service hardening** | systemd: NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp, RestrictAddressFamilies. Windows: service SID, restricted token. macOS: LaunchDaemon with constrained user |
| **RPC authorization** | Service-control commands require separate `service` scope token |
| **Network** | Existing mTLS/WSS between coordinator and worker |
| **Privilege delegation** | Windows: SCM ACL. Linux: polkit rule. macOS: sudoers drop-in. Enables coordinator RPC without elevation |
| **Shell injection prevention** | All OS commands use `execFile` (not `exec`) — no shell interpolation |
| **Audit** | All service-control commands logged with timestamp, source, and outcome |

---

## Implementation Notes

- All shell commands MUST use `execFile` / `execFileNoThrow` utility (never `exec`) to prevent command injection
- Follow existing singleton pattern for ServiceManager if needed at runtime
- WinSW binary should be integrity-checked (SHA256) before use
- Consider adding `--dry-run` output that shows exactly what commands would be executed, for transparency during install
