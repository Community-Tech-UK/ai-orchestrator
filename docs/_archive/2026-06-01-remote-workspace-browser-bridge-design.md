# Remote Workspace And Browser Bridge Design

## Context

James wants to stay on the Mac, work in a local project folder, and ask AI
Orchestrator to operate the paired Windows PC as a real execution target:

- Copy a local `.env` file to the Windows project.
- Sync or materialize the current Mac workspace on Windows.
- Run browser tests on Windows.
- Drive a Windows browser that has its own authenticated sessions for sites
  such as Apple developer/app management screens.

The current codebase already has most transport primitives:

- Remote workers connect outward to the Mac coordinator over WebSocket RPC.
- `remote-fs` supports read directory, stat, search, read file, write file,
  single-file transfer, and local-to-remote/remote-to-local directory sync.
- Remote CLI sessions already run on worker nodes through `RemoteCliAdapter`.
- Browser Gateway already provides managed local browser profiles, policy,
  approval requests, grants, audit records, screenshots, snapshots, clicks,
  typing, and form filling.

The gaps are product-level orchestration and remote browser ownership:

- Agents discover `run_on_node`, but not direct file/sync/browser bridge tools.
- The worker security filter currently blocks `.env` read/write, which is good
  by default but conflicts with explicit user-approved secret transfer.
- Browser Gateway is local-only. Remote sessions deliberately receive no local
  Browser Gateway MCP config because local sockets and profiles do not exist on
  the worker.
- Remote sessions also lose coordinator-owned Orchestrator MCP config today,
  because the Mac config paths cannot be passed to Windows. A session that runs
  on Windows must receive worker-local bridge tooling if it is expected to ask
  the Mac coordinator to copy files or control remote Browser Gateway.

## Goals

1. Make "copy this file to Windows" work from a Mac session without requiring
   SMB, shared drives, or manual path translation.
2. Make "browser test this app on Windows" run in the matching Windows project
   folder with the Windows browser runtime.
3. Make "use the Windows authenticated browser" control a separate persistent
   Orchestrator-managed profile on Windows.
4. Never copy browser cookies, tokens, or profile data between Mac and Windows.
5. Pause for manual login, 2FA, CAPTCHA, credential entry, destructive submits,
   or unclear browser actions.
6. Keep remote file and browser operations auditable, bounded, and explicit.
7. Make the bridge available from both local Mac sessions and remote Windows
   sessions. A Windows-running agent should be able to request coordinator
   bridge operations without knowing Mac filesystem paths directly.

## Non-Goals

- Do not make macOS and Windows expose their full filesystems to each other via
  SMB, NFS, drive mapping, or admin shares.
- Do not copy authenticated browser sessions from Mac to Windows.
- Do not allow a Windows service running in session 0 to control a user desktop
  browser profile.
- Do not expose raw Chrome DevTools endpoints, profile paths, cookies, local
  Browser Gateway sockets, or transport tokens to provider agents.
- Do not relax `.env` access globally. Secret transfer is an explicit workflow,
  not a new default filesystem permission.
- Do not make browser test mode reuse the authenticated Browser Gateway profile.
  Tests run with disposable or project-managed browser state unless the user
  explicitly chooses otherwise.

## Recommended Approach

Build an Orchestrator-native bridge on top of the existing remote-node
transport. The Mac coordinator remains the control plane. The Windows PC is a
worker node with two runtime capabilities:

1. **Worker service** for always-on CLI, filesystem, sync, and test execution.
2. **Desktop browser agent** for Browser Gateway operations in the logged-in
   Windows user session.

The worker service may run at boot. The desktop browser agent must run after
user login, through startup/Run key/task scheduler/launch-at-login style
integration, because it needs access to an interactive desktop and its own
managed browser profile.

The coordinator remains the authority for workspace mappings, secret-transfer
decisions, Browser Gateway policy, approval requests, grants, and audit. The
worker and desktop browser agent provide execution and observed browser state;
they do not independently decide whether an agent may perform sensitive work.

The bridge has two rollout milestones:

1. **File/test bridge MVP**: workspace mapping, safe file copy/sync, explicit
   `.env` transfer, remote-session bridge tools, and Windows test execution.
2. **Remote authenticated browser**: Windows desktop browser agent, remote
   Browser Gateway proxy, manual login handoff, and coordinator-gated
   mutating browser actions.

The first milestone is useful on its own and should not depend on the desktop
browser agent being implemented.

## Architecture

### Workspace Bridge

Add a coordinator-side workspace bridge service that resolves a local workspace
and a target remote node into a remote project path.

Inputs:

- local workspace path
- target node id or target selector such as `windows`
- optional remote path override
- optional sync/copy policy
- calling instance id and execution location

State:

- per-node workspace mappings, for example:
  - `/Users/suas/work/orchestrat0r/ai-orchestrator`
  - `C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator`
- recent successful mappings
- per-workspace default target node
- whether the mapping was user-confirmed or inferred
- last sync direction, last sync time, and last dry-run summary

The bridge should first use configured mappings. If none exist, it can suggest
a default under the worker's advertised `workingDirectories`, but writes should
still require the remote path to be within a browsable/working root.

Paths stay native to their owning machine. Do not normalize Windows paths to
POSIX or POSIX paths to Windows on the wire. Store mappings as two tagged
endpoints:

```ts
interface WorkspaceBridgeEndpoint {
  nodeId: 'local' | string;
  path: string;
  platform: 'darwin' | 'win32' | 'linux';
}
```

Persist mappings in application state/SQLite with no file contents, no secrets,
and no transport tokens. The record should include enough metadata to explain
why a mapping was selected, but not enough to grant filesystem access by itself.

First-time mappings require confirmation before any write, sync, or command
execution. After confirmation, the mapping can be reused automatically for the
same local workspace and node.

By default, copy and sync operations are anchored to the current instance
workspace. Agent-supplied absolute paths outside that workspace require explicit
user confirmation, even when the path is locally readable.

All path authorization must use canonical/resolved paths for the endpoint that
owns the path. On Windows, root comparisons must account for case-insensitive
drive paths while still preserving the original path string for display and RPC
payloads. For writes to paths that may not exist yet, validate the nearest
existing parent directory after symlink resolution before creating anything.

### Remote File Tools

Expose Orchestrator MCP tools that call the existing remote-fs services:

- `copy_file_to_node`
- `copy_file_from_node`
- `sync_workspace_to_node`
- `remote_fs_stat`
- `remote_fs_read_dir`
- `resolve_remote_workspace`

These tools should be available alongside `list_remote_nodes`, `run_on_node`,
and `read_node_output`.

For common language like "Windows PC", "other machine", "copy my .env", and
"browser test on Windows", tool descriptions should tell agents to inspect
remote nodes and resolve a workspace mapping before running work.

### Tool Availability Model

There are two caller locations:

1. **Local coordinator sessions** run on the Mac. They can call coordinator
   Orchestrator MCP tools directly.
2. **Remote worker sessions** run on Windows. They cannot use Mac-local MCP
   config paths. They need a worker-local MCP bridge that tunnels bridge-tool
   calls back through the worker connection to the Mac coordinator.

The implementation must not reintroduce Mac filesystem config paths into remote
spawn options. Instead, remote `instance.spawn` should receive or generate
worker-local MCP config for a small Orchestrator bridge:

- `list_remote_nodes`
- `resolve_remote_workspace`
- file copy/sync tools
- remote Browser Gateway tools for the current node
- `read_node_output` where useful

The bridge should preserve the existing spawn-depth guard for `run_on_node`.
Remote leaf sessions may lose spawn-capable tools, but they should keep
read/copy/status tools that are safe for the current user-approved context.

The worker-local bridge needs a concrete runtime and authority boundary:

- It must be installed or generated from files available on the worker machine,
  for example the worker bundle's own `aio-mcp`/Node entrypoint. It must not
  reference `/Users/...` Mac paths.
- Each spawned remote instance gets a short-lived, per-instance bridge token or
  capability descriptor. The worker-local MCP bridge presents that token when
  tunneling requests back to the coordinator.
- Bridge tokens must not be passed on command lines where they show up in
  process listings. Prefer an inherited environment variable or worker-managed
  ephemeral config file with restrictive permissions, and redact the value from
  logs, transcripts, and Doctor artifacts.
- The coordinator resolves the token to the calling instance, its source
  workspace mapping, and its allowed tool scope. A random Windows process or a
  different remote instance must not be able to use the bridge to copy Mac
  files or control Browser Gateway.
- The bridge should expose current-workspace operations by opaque context
  where possible. It should not require the remote agent to know or supply raw
  Mac absolute paths for common operations like "copy my `.env`".

### Contracts, Packaging, And Runtime Distribution

The bridge adds new coordinator/worker/browser protocol surface. Keep those
contracts in the existing shared-contract and build patterns so the packaged
app and Windows worker do not diverge from dev mode.

- Prefer extending existing `@contracts/schemas/remote-node`,
  `@contracts/schemas/browser`, `@contracts/types/browser`, and related
  channels where that fits. If a new `@contracts/schemas/...`,
  `@contracts/channels/...`, or `@contracts/types/...` subpath is added, update
  every alias/export sync point together: `packages/contracts/package.json`,
  `tsconfig.json`, `tsconfig.electron.json`, `vitest.config.ts`, and the
  generated `src/main/register-aliases.ts`.
- Run the existing alias/export guard path after contract changes:
  `npm run generate:aliases`, `npm run verify:exports`, and
  `npm run check:contracts`. A typecheck-only pass is not enough because
  TypeScript path aliases do not rewrite emitted JavaScript for packaged
  Electron.
- Validate all bridge RPC, IPC, and MCP payloads with Zod at the boundary.
  Include protocol version and capability fields in browser-control and
  worker-local bridge handshakes so old/new coordinator and worker builds fail
  closed per capability instead of crashing or silently downgrading policy.
- The worker-local MCP bridge and desktop browser agent must be available from
  files installed on the Windows machine. Generated configs must point to an
  existing worker-local executable or bundle path in both dev and packaged
  installs; they must not assume the Mac source checkout, `process.cwd()`, or a
  coordinator-only `process.resourcesPath`.
- Packaging/build checks should fail if a required bridge entrypoint is missing
  from the worker/browser-agent distribution. Runtime health checks should
  report missing bridge binaries as capability-specific unavailable states with
  repair instructions, not as generic spawn failures.

### Transport Security And Credential Lifecycle

Secret transfer and authenticated browser control are sensitive enough that the
bridge must know whether the node connection is protected before allowing them.

- Treat `wss://` with validated TLS, a localhost SSH tunnel, or an encrypted
  private overlay such as Tailscale as protected transport. Treat plain
  unauthenticated LAN `ws://` as unprotected unless the app can prove it is
  inside an explicitly trusted overlay.
- The worker registration and browser-control registration should expose a
  transport-security summary to the coordinator: URL scheme, TLS/overlay/tunnel
  status when known, certificate validation status for TLS, and whether the
  coordinator considers sensitive bridge operations allowed.
- Dedicated secret transfer, browser-control registration, authenticated
  Browser Gateway actions, and remote observation artifact transfer must fail
  closed on unprotected transport. A developer-only one-time override may exist,
  but it must be explicit, audited, redacted, and unavailable to provider
  agents.
- Remote CLI/file/test workflows that do not move secrets or authenticated
  browser state may still run on ordinary paired connections, but the UI and
  tool results should make the reduced capability clear.

Credential lifecycle must be explicit:

- Enrollment tokens remain single-use and short-lived. Node transport tokens,
  browser-control credentials, and worker-local bridge tokens are separate
  credentials with separate scopes.
- Browser-control credentials are issued only after the worker node is paired,
  are bound to that node identity, and are revocable independently from the
  worker-service token.
- Worker-local bridge tokens are per remote instance, short-lived, and
  invalidated when the instance exits, hibernates, is killed, or the worker
  disconnects long enough that the coordinator can no longer reason about its
  state.
- Revoking a worker node must also revoke browser-control credentials for that
  node, invalidate outstanding worker-local bridge tokens, release profile
  controller locks, and mark pending remote browser approvals/grants as no
  longer executable. Existing audit rows remain immutable.
- Credential values must not appear in process arguments, MCP config text shown
  to the model, logs, Doctor output, transcripts, audit summaries, or renderer
  notifications. Diagnostics may show credential kind, scope, issue time, and
  redacted suffix/prefix only.

### Secret Transfer

`.env` and similar files remain restricted for ordinary remote reads/writes.
Add an explicit secret-transfer path:

- Requires a direct user request in the current turn.
- If the request did not originate from an inspectable user message, requires a
  renderer approval before reading the local secret file.
- Allows local-to-remote write of the named secret file through a dedicated
  coordinator-authorized transfer method. Do not implement this by broadly
  relaxing ordinary `remote-fs` `readFile`/`writeFile`; those operations should
  continue to reject restricted filenames such as `.env`.
- Does not include file contents in tool results, logs, audit details, or
  assistant text.
- Returns metadata only: source basename, target path, size, node id, and
  status.
- Defaults to overwrite only when the user asked to copy/update the file; an
  optional `ifExists` mode can support `fail`, `overwrite`, or `backup`.
- Defaults the target to the same relative path inside the confirmed workspace
  mapping. Arbitrary target paths require confirmation.
- Resolves the local source from the current workspace context and requires it
  to be a regular file. If the requested source is a symlink or an absolute
  path outside the workspace, the coordinator must resolve the final target and
  require explicit confirmation before reading it.
- Uses a bounded size limit suitable for config files; large secret-like files
  require manual handling or a separate approved workflow.
- Preserves bytes exactly. Do not normalize line endings, encodings, or final
  newlines during secret copy.
- Does not return content hashes for secret files. Hashes of small config files
  can leak enough information for offline guessing.

This is intentionally one-way for the main use case. Remote-to-local secret
copy should require the same explicit user wording and should not be used as a
generic way for agents to inspect secrets.

Non-secret `copy_file_from_node` should also return metadata only. The bytes
move directly from the remote node to the chosen local path; they are not
returned to the model as file content. Restricted remote files stay blocked
unless the same explicit secret-transfer approval path is used.

Sync operations must continue to exclude sensitive files by default. Copying
`.env` is a separate explicit action; it should not happen implicitly as part
of "sync workspace" unless the user asked for secrets/config files to be
included.

Because the current sync implementation joins remote paths in coordinator code,
the bridge must use endpoint-native path joining or delegate path joining to
the remote node. Windows drive-letter paths, UNC-style paths, and backslash
separators must not be mangled by POSIX joining.

### Transfer And Sync Safety

File transfer must be bounded and atomic enough for developer workflows:

- Do not raise the existing in-memory transfer limits without adding chunked or
  streaming transfer. Large files should fail with a clear "file too large"
  result or move through a streaming path that does not load the whole file in
  the coordinator or worker process.
- Remote writes, including dedicated secret-transfer writes, should write to a
  temporary file in the target directory and then rename into place. Clean up
  temp files on failure. If `ifExists: backup` is selected, create the backup
  before the rename and report only metadata.
- Before any remote write, resolve the nearest existing parent directory on the
  worker and verify it remains inside the allowed root. A path such as
  `workspace/link/.env`, where `link` is a symlink to a directory outside the
  workspace, must be rejected or require a separate explicit approval flow.
- Serialize mutating operations per workspace mapping and node. A sync, file
  copy, clean mirror delete, dependency setup, and browser-test command should
  not race each other against the same remote workspace. Test execution should
  start only after the chosen sync/copy operation has completed or failed.
- Sync manifests may include non-secret content hashes for change detection,
  but secret-transfer results and secret audits must not include content hashes.

Cross-platform sync must detect target-platform path collisions before writing:

- A sync from Mac/Linux to Windows must reject or require user resolution when
  two source entries collapse to the same Windows path, for example `Readme.md`
  and `README.md`, names that differ only by trailing spaces/dots, or names
  that normalize to the same Unicode form on the target filesystem.
- Windows targets must reject paths containing reserved device names such as
  `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, and `LPT1`-`LPT9`, alternate data
  stream syntax using `:`, embedded nulls, or target-invalid characters.
- Relative paths in manifests should use a canonical sync representation for
  comparison, but every write/delete must be resolved by the endpoint that owns
  the target. The canonical sync key is not authority to bypass native path
  checks.
- Collision checks run during dry-run/preflight and block transfer before any
  files are created, modified, or deleted. They should return the conflicting
  source paths and the target path they collapse to.

Repeated syncs need conflict detection, not just "source wins":

- Store a non-secret baseline manifest for the last successful sync per
  workspace mapping, direction, exclude policy, and target node. The baseline is
  metadata for conflict detection, not authorization.
- On later syncs, compare source, target, and baseline before overwriting or
  deleting target files. If a target file changed since the last baseline and
  the proposed sync would overwrite or delete it, return a sync-conflict result
  instead of applying the change.
- If both source and target changed relative to the baseline, report a
  two-sided conflict with the source path, target path, sizes/mtimes, and
  non-secret hashes where available. Do not include secret hashes or contents.
- If no baseline exists, treat the operation as a first sync and require the
  existing dry-run/confirmation path before destructive or broad overwrites.
- Explicit user choices may resolve conflicts with `overwrite_target`,
  `keep_target`, `backup_then_overwrite`, or `skip`, but agents must not choose
  destructive conflict resolution silently.

### Operation Lifecycle, Progress, And Cleanup

Any bridge action that can outlive one bounded RPC must be modeled as an
operation rather than an anonymous request. This includes workspace sync, file
copy/secret transfer, dependency setup, browser-test commands, dev-server
startup, manual browser handoffs, and remote browser mutations.

Operation state should build on the existing sync job shape instead of creating
a separate one-off mechanism for each feature:

- Each operation has an id, type, caller instance id, node id, workspace mapping
  id, mutating/non-mutating flag, created/updated timestamps, timeout/deadline,
  status, progress summary, and safe result metadata.
- Long operations use explicit states such as `queued`, `preflighting`,
  `waiting_for_approval`, `running`, `waiting_for_user`, `succeeded`, `failed`,
  `cancelled`, `timed_out`, `stale`, and `unknown`.
- Tool calls return the operation id and current status. Agents can poll or
  subscribe for progress instead of keeping one large RPC open.
- Mutating operations require an idempotency key. Retrying a timed-out or
  reconnected tool call with the same key returns the existing operation status
  rather than duplicating file writes, setup commands, test launches, dev-server
  starts, or browser actions.
- Terminal/test output and browser-agent events should include monotonically
  increasing sequence numbers or byte offsets per operation/session. After a
  reconnect, the coordinator must report whether output is complete, still
  streaming, or has a gap; it must not silently rerun the command to recreate
  missing output.
- Cancellation and timeout are first-class. They should request remote process
  termination, cancel sync work, clean temporary files, release workspace
  mutation locks and profile locks, and write a final audited status. Cleanup is
  best-effort, but failures are reported as cleanup failures rather than hidden.
- If the coordinator restarts or a worker disconnects while a mutating operation
  is in flight, the operation becomes `stale` or `unknown` until reconciled with
  the worker. The coordinator must not assume success or replay the mutation
  automatically.
- Workspace mutation locks should be persisted or recoverable enough that a
  restart cannot immediately start a second destructive operation against a
  workspace whose previous mutation may still be running.

### Remote Browser Gateway

Extend Browser Gateway with a remote execution backend instead of exposing raw
Chrome automation to provider agents.

Remote browser transport:

- The Windows desktop browser agent should register as a browser-control
  subconnection for the worker node using its own outbound WebSocket session.
  This keeps the existing "remote machines dial into the coordinator" network
  model and avoids relying on inbound Windows firewall access.
- The browser-agent credential is scoped to browser control for that node and
  is revocable independently from the worker service token. It must not grant
  CLI, terminal, or filesystem access.
- The browser-control registration must be bound to an already paired worker
  identity. A self-declared `nodeId` from the desktop browser agent is not
  authority by itself; the coordinator must validate that the browser-control
  credential was issued for that node and, where possible, for the same machine
  installation as the worker service.
- The registration includes node id, Windows user/session identity, browser
  runtime status, supported profile directory, and browser-agent version.
- If a future implementation relays through the worker service instead, the
  service-to-desktop IPC must be local-only, authenticated, and scoped to the
  logged-in user session. The coordinator-facing semantics should remain the
  same.

Coordinator side:

- Adds a `RemoteBrowserGatewayClient` that sends Browser Gateway commands to a
  node's browser-control connection.
- Keeps policy, approval request presentation, grants, and audit records
  coherent in the Mac app.
- Reports remote browser health, profile status, active target, and manual
  login state.
- Adds `nodeId` and Windows user/session identity to profile, target,
  approval, grant, and audit DTOs where the browser is remote. Remote profile
  IDs must be treated as node-scoped identifiers; do not assume a bare profile
  ID is globally unique across machines.
- Performs policy, grant matching, and audit decisions in the coordinator. For
  mutating actions, it first requests remote observed element/page context,
  classifies the action, checks grants/approval, then sends an execute command
  back to the remote browser agent.
- Uses an inspect-token or observed-context revision for mutating actions. The
  remote browser agent must verify that the current target, origin, and element
  still match the approved context immediately before executing. If they do not,
  it returns a non-running stale-context result.

Persistence and migration:

- Extend Browser Gateway persistence for remote identity instead of overloading
  local profile IDs. Add nullable remote fields such as `nodeId`, Windows
  user/session identity, browser-agent id/version, and remote profile key to
  profile, target, approval request, grant, and audit records. Local browser
  records should either use `nodeId: local` in DTOs or a nullable persisted
  field with an explicit local default in query logic.
- Add indexes that match runtime lookup paths: active grants by
  instance/node/user-session/profile/origin/expiry, approval requests by
  status/node/profile/created time, profile-controller locks by node/user
  session/profile, and audit listing by node/profile/instance.
- Migration must preserve existing local Browser Gateway profiles, grants,
  approvals, and audit entries. Existing local records must not accidentally
  match remote profiles with the same bare profile id.
- Update all renderer IPC, MCP, and safe DTO projections together so local and
  remote browser objects have one stable contract shape.

Observation and artifact privacy:

- Treat remote snapshots, screenshots, accessibility trees, console messages,
  and network summaries as sensitive authenticated-browser observations.
  Redact and size-limit them before they reach provider agents, logs, audit
  summaries, or transcripts.
- Screenshot bytes should not be logged or embedded in audit rows. Store
  screenshot artifacts, if needed, under Orchestrator-managed storage with an
  artifact id, bounded size, retention/cleanup policy, and node/profile/target
  metadata. Audit entries should reference only the artifact id.
- Remote Browser Gateway should prefer redacted text snapshots and structured
  element summaries over full-page text dumps. Any screenshot or page text sent
  to the model must be bounded, explicitly tied to the current user task, and
  marked as untrusted page content.
- Approval and manual-login UI may display screenshots locally for James, but
  those screenshots must not be treated as agent-safe output by default.
  Provider-facing results should receive safe summaries or artifact references,
  not raw authenticated screenshots, unless the existing Browser Gateway policy
  explicitly allows that mode.

Windows desktop browser agent side:

- Starts in the logged-in Windows user session.
- Owns a separate persistent Orchestrator-managed Chrome/Edge profile.
- Provides Browser Gateway-compatible methods: create/open profile, list
  targets, find/open URL, snapshot, screenshot, click, type, fill form, select,
  upload file, request user login, pause for manual step, health, and audit
  event forwarding.
- Never returns cookies, storage state, debugging endpoints, or profile
  filesystem paths.
- Reports only safe observed page context needed for Browser Gateway policy:
  current URL/origin, target metadata, accessibility/element summaries,
  screenshot artifacts, and bounded/redacted page text.
- Stores profiles under an Orchestrator-managed directory for that Windows user
  account, not under the service account and not in the user's personal daily
  browser profile.

Remote profile ownership and contention:

- A managed remote browser profile can have at most one active controller at a
  time. If another instance or another Windows user session already controls
  the profile, Browser Gateway should return a profile-busy result or require
  explicit user takeover.
- Grants and approvals are scoped to the tuple of instance id, node id, Windows
  user/session identity, profile id, target/origin, action class, and expiry.
  A grant for a Mac profile, another Windows user, or another node must not
  match the remote profile.
- The desktop browser agent must not attach to the user's default personal
  Chrome/Edge profile unless a future explicit existing-tab workflow is
  designed and approved separately.

Remote browser profiles are not copied from Mac. The first time a site needs
authentication, Browser Gateway returns a manual-login-required result. James
logs into the Windows profile directly. Future sessions reuse that Windows
profile.

The desktop browser agent may be offline while the worker service is connected.
In that state, file sync, CLI runs, and browser test commands can still work,
but authenticated Browser Gateway control must return a clear
`remote_browser_agent_unavailable` result with repair instructions.

If the browser-control connection drops while a browser action is pending, the
coordinator must fail or cancel the action with a retryable remote-disconnected
result. It must not queue mutating browser commands for automatic replay after
reconnect; the agent must re-snapshot/re-inspect and pass policy/grant checks
again. Read-only health and snapshot requests may be retried after reconnect
when they have no side effects.

Manual login, CAPTCHA, 2FA, and review handoffs must use the existing
Browser Gateway `requires_user` shape with stable `requestId`s. The coordinator
persists the pending request, the renderer shows it, and the agent polls or
retries with the request id after James completes the step. Do not keep a
long-running browser-control RPC open while waiting for user action, and do not
auto-execute the original mutating action merely because a manual step was
completed.

### Browser Test Mode

Add a command-level workflow for Windows browser testing:

1. Resolve target node.
2. Resolve or create the remote workspace mapping.
3. Sync the current workspace or confirm it is already present.
4. Preflight the Windows runtime: CLI provider, package manager, test command,
   browser runtime, and whether dependencies appear installed.
5. Run any configured/user-approved setup command if dependencies are missing.
6. Run the selected test command on the Windows node in the remote workspace.
7. If the command needs a browser, use the worker's installed Chrome/Edge.
8. Stream output back to the Mac session.

This is separate from interactive Browser Gateway control. Playwright/Vitest
test commands run as normal CLI commands on Windows. Browser Gateway is used
when the agent needs to inspect or manipulate a real browser session.

Browser test mode must not inherit or point at the authenticated managed
Browser Gateway profile by default. If a test command accepts browser profile
or user-data-dir flags, the workflow should use a disposable/project test
profile unless the user explicitly approves using a persistent test fixture.

Do not infer and run arbitrary shell commands from vague prompts. The test
command should come from one of:

- explicit user instruction,
- project config such as `package.json` scripts,
- an app-level remembered per-workspace test command,
- a proposed command that the user confirms.

Dependency setup follows the same rule. The bridge may suggest `npm install`,
`pnpm install`, or similar based on lockfiles and missing dependencies, but it
should not run setup commands unless they are project-configured or approved by
the user.

Command execution must be modeled as structured intent, not raw string
concatenation:

- Store the command as executable/script, arguments, cwd, shell mode, source
  provenance, environment overrides, timeout, and expected output/artifact
  policy.
- Prefer argv-style process spawning for bridge-owned setup/test/dev-server
  helpers. Use shell mode only for explicit project scripts or user-approved
  shell commands, and show the exact shell line, cwd, and redacted environment
  keys in approval/audit surfaces.
- Never interpolate agent-provided paths, URLs, ports, or filenames into a shell
  string. Pass them as arguments where possible, or quote/escape them with a
  platform-specific library when shell mode is unavoidable.
- Child command environments should be sanitized. Do not inherit worker node
  transport tokens, browser-control credentials, worker-local bridge tokens, or
  coordinator secrets into setup/test/dev-server processes unless a specific
  approved command requires a specific non-secret variable.
- Persist remembered per-workspace commands with their provenance and last
  confirmation time. If the command source changes materially, require a fresh
  dry-run/confirmation instead of treating it as the same remembered command.

When testing a dev app, `localhost` means the Windows machine if the browser
runs on Windows. The workflow should either start the app on Windows after
syncing, use a routable Mac URL/tunnel intentionally, or fail with a clear
"server not reachable from Windows" diagnosis.

If browser test mode starts a dev server on Windows, that server is a managed
child operation:

- The dev-server command follows the same source rules as test/setup commands:
  explicit user instruction, project config, remembered per-workspace config,
  or user-confirmed proposal.
- The workflow records the remote process/session id, workspace mapping,
  command, environment redaction policy, selected port/URL, and parent browser
  test operation id.
- Readiness is proven with a bounded probe such as HTTP reachability, expected
  log output, or a project-configured health check. A startup timeout fails the
  browser-test operation instead of proceeding against a half-started server.
- Port conflicts are handled explicitly. Reuse an existing server only when it
  can be tied to the same workspace/user intent or James approves reuse; do not
  kill unknown processes just to free a port.
- Server logs stream with bounded buffers and output sequencing. They must not
  leak secrets from environment variables or command echoes into agent-visible
  output.
- Unless the user asks to keep the server running, cancellation, failure, or
  completion of the browser-test operation should stop the dev server and report
  cleanup status. Orphaned remote servers must be visible in operation/health
  state with a stop action.

Remote setup/test/dev-server output is provider-visible by default, so it needs
the same care as browser observations:

- Tool results should stream bounded chunks and retain full logs as local
  artifacts only when needed. Provider-facing summaries should include enough
  context to debug failures without dumping unbounded process output.
- Redact common credential patterns, known transport/bridge tokens, approval
  tokens, and any secret values the coordinator already has in memory for an
  active secret-transfer operation. Do not persist those secret values just to
  support future redaction.
- If a command appears to dump environment variables, `.env` contents, or other
  restricted files, truncate/redact the provider-facing stream and surface a
  local-only artifact/review path for James.

Workspace sync for test mode should be conservative:

- exclude `.git`, `node_modules`, build outputs, caches, and secret files by
  default,
- avoid following symlinks outside the source workspace or remote root,
- do not delete extraneous files unless the user explicitly requests a clean
  mirror,
- show a dry-run summary for the first sync of a mapping,
- preserve native path handling and fail on out-of-root targets.

Session launch on a mapped Windows workspace should validate the final remote
cwd against the worker's allowed roots using resolved paths. A symlinked cwd
that escapes the allowed root must fail before any CLI process starts.

## User Flows

### Copy `.env` To Windows

1. User asks: "Copy my `.env` file over to Windows."
2. Agent calls `list_remote_nodes`.
3. Agent calls `resolve_remote_workspace` for the current Mac cwd and Windows.
4. Agent calls `copy_file_to_node` with secret-transfer intent.
5. Coordinator reads local `.env`, writes it to the mapped Windows path, and
   returns metadata only.

### Browser Test App On Windows

1. User asks: "Browser test this app on my Windows machine."
2. Agent resolves the Windows node and workspace mapping.
3. Agent syncs the workspace if needed.
4. Agent preflights browser/runtime/dependency readiness on Windows.
5. Agent runs configured or user-approved setup only if needed.
6. Agent runs the configured test command on Windows.
7. If no server is running on Windows, the workflow starts the project dev
   server or reports the missing command.
8. Output and failures stream back to the Mac session.

### Authenticated Apple Screen Flow

1. User asks the agent to operate Apple app screens from Windows.
2. Agent chooses the Windows Browser Gateway target.
3. Remote Browser Gateway opens the managed Windows profile.
4. If Apple login is missing or expired, the gateway returns manual login
   required.
5. UI instructs James to remote into Windows and sign in.
6. Agent resumes after the profile is authenticated.
7. Sensitive or destructive actions still use existing Browser Gateway approval
   and grant rules.

## Security And Policy

- Secret transfer, authenticated remote browser control, and remote browser
  observation artifacts require protected transport. On unprotected transport,
  these capabilities fail closed and report repair guidance.
- Remote browser control only uses Orchestrator Browser Gateway contracts.
- No provider-facing tool receives raw CDP, debugging ports, profile dirs,
  cookies, local storage, tokens, or session exports.
- Browser page content remains untrusted. Existing Browser Gateway untrusted
  content guidance applies to remote browser snapshots and screenshots.
- Remote file operations stay within worker configured roots.
- Secret transfer is explicit, minimal, redacted, and audited as metadata.
- Remote worker tokens and pairing credentials stay transport-only and are not
  surfaced to agents.
- Desktop browser agent registration should distinguish browser-control
  capability from always-on worker-service capability.
- Remote Browser Gateway policy decisions are made by the coordinator, not by
  the agent or provider process.
- Remote browser profile data lives only on the Windows machine under
  Orchestrator-managed user data. The Mac stores metadata and audit records, not
  the profile contents.
- File uploads through remote Browser Gateway must use files within the remote
  workspace or another user-approved remote path. Uploading local Mac files to
  a remote browser requires an explicit copy-to-node step first.
- Remote Browser Gateway execution must be fail-closed on stale observed
  context: changed target, changed origin, missing element, or mismatched
  element metadata requires re-inspection and approval/grant matching again.
- Browser-agent and worker-service versions must be reported and checked for
  protocol compatibility. A version mismatch should disable only the affected
  capability rather than taking down the entire remote node.
- Worker revocation cascades to scoped browser-control credentials,
  worker-local bridge tokens, profile-controller locks, and pending remote
  browser grants/approvals for that node.

## Error Handling

- No connected Windows node: return a clear "no matching node connected" error
  with available nodes.
- Unprotected transport for a sensitive operation: fail closed, explain that
  secret transfer or authenticated Browser Gateway requires `wss://`, SSH
  tunnel, or trusted encrypted overlay transport, and leave non-sensitive
  CLI/file/test capabilities available.
- No workspace mapping: suggest a remote path under an allowed worker root and
  require user confirmation before first write.
- Remote path outside root: fail with the existing out-of-scope error.
- Remote write parent resolves outside root: fail before creating directories or
  temp files, and explain that a symlink or junction escapes the allowed root.
- Remote working directory escapes root after symlink resolution: fail before
  spawning the remote CLI and point the user to select a different folder.
- Desktop browser agent offline: report that CLI/file workflows are available
  but authenticated browser control requires Windows user login/session agent.
- Login required: return a non-running Browser Gateway result that asks the user
  to authenticate on Windows, with a stable `requestId` that can be polled or
  retried after the manual step.
- Manual handoff request expires before completion: return an expired
  request/status result and require a fresh inspection or login request rather
  than reusing stale page context.
- Browser profile locked: report the locked profile and offer to close/retry
  rather than silently creating another unmanaged profile.
- Remote profile already controlled by another instance or Windows session:
  return profile-busy with the current controller metadata and require explicit
  user takeover before interrupting it.
- Browser-control registration cannot be bound to the paired worker identity:
  reject the registration and leave CLI/file/test capabilities available.
- Worker-local MCP bridge executable or browser-agent entrypoint missing on the
  Windows machine: mark only that bridge capability unavailable and show the
  missing path/build version in repair diagnostics.
- Bridge protocol major version mismatch: disable the affected bridge
  capability and report coordinator, worker-service, and browser-agent versions.
- Worker/node revoked while bridge work is pending: cancel sensitive operations,
  invalidate scoped credentials, release locks, and return a revoked-node result
  rather than retrying.
- Secret target exists: use the requested overwrite/backup/fail policy.
- Remote session lacks bridge tools: report that worker-local Orchestrator MCP
  injection is missing, instead of falling back to unsupported Mac paths.
- Sync conflict or first sync: return a dry-run summary and require
  confirmation before overwriting many files or deleting anything.
- Workspace mutation already running: return the active operation id and status
  instead of starting a second sync/copy/setup/test mutation on the same mapped
  workspace.
- Transfer too large for the configured non-streaming path: fail before reading
  the full file into memory and suggest either excluding it, using a streaming
  transfer path, or handling it manually.
- Test command missing: show candidate scripts/commands or ask for the command;
  do not guess a destructive shell command.
- Windows user logged out or desktop agent stopped: authenticated Browser
  Gateway control is unavailable until the desktop agent starts; CLI/file/test
  workflows remain available if the worker service is connected.
- Browser-agent protocol mismatch: report the installed and required versions,
  mark remote Browser Gateway unavailable, and leave file/test workflows intact.
- Browser-agent disconnect during pending action: fail or cancel the operation;
  do not replay mutating commands after reconnect without a fresh inspection and
  policy/grant check.
- Remote observation too large or too sensitive to expose safely: return a
  redacted/truncated observation with an explanation, or store an artifact for
  local UI review without sending raw content to the provider agent.
- Stale browser action context: return a retryable stale-context result and ask
  the agent to re-snapshot/re-inspect before retrying.
- Dependency setup required: present the setup command and reason; run it only
  when configured or approved.
- Bridge operation cancelled or timed out: return the final operation status,
  cleanup status, and any safe partial metadata; do not continue work in the
  background without showing it as an orphaned/stale operation.
- Worker disconnect or coordinator restart during a mutating operation: mark
  the operation stale/unknown, block conflicting workspace mutations, and
  require reconciliation before retrying or replaying anything.
- Output stream sequence gap after reconnect: report the gap and current remote
  process state instead of fabricating or rerunning output.
- Dev-server port conflict: show the conflicting port/URL and whether the
  process can be identified as the same workspace; require approval before
  reuse or termination.
- Dev-server readiness timeout: stop the managed server if it was started by
  the operation, return captured bounded logs, and do not run browser tests.
- Dev-server cleanup failure: report the remote process/session id and mark the
  server as orphaned so the UI or a follow-up tool can stop it explicitly.
- Cross-platform path collision or invalid Windows target path: fail during
  dry-run/preflight with the conflicting source paths and target path; do not
  write, delete, or rename any files.
- Sync conflict against the last baseline: report the changed source/target
  paths and require explicit resolution before overwrite/delete.
- Missing sync baseline for a mapped workspace: treat as first sync, return a
  dry-run summary, and require confirmation before broad overwrites or clean
  mirror deletes.
- Unsafe command construction: reject shell execution when agent-provided
  values would be interpolated; return the structured command preview and ask
  for an approved command or argv-safe form.
- Sanitized command environment removed required variables: fail with missing
  environment keys and ask for explicit non-secret env approval rather than
  falling back to inheriting all worker-service variables.
- Remote command output contains likely secrets or restricted-file contents:
  redact/truncate provider-facing output and store any full diagnostic artifact
  only in local Orchestrator storage with explicit retention.

## Implementation Slices

1. **Workspace bridge and coordinator file tools**
   - Add workspace mapping state.
   - Add MCP tools for resolve, copy, stat, read-dir, and sync.
   - Add explicit secret-transfer support for local-to-remote `.env` copy.
   - Add first-time mapping confirmation and sync dry-run behavior.
   - Add endpoint-native path joining for sync/copy operations, especially
     Windows drive-letter paths.
   - Add canonical parent validation, atomic write/backup behavior, transfer
     size limits, and per-mapping mutation serialization.
   - Add target-platform relative path validation and collision detection for
     Windows reserved names, case folding, trailing dot/space normalization,
     invalid characters, and Unicode normalization.
   - Add last-successful-sync baselines and three-way conflict detection for
     repeated syncs before target overwrite/delete operations.

2. **Worker-local Orchestrator bridge injection**
   - Generate worker-local MCP config for remote sessions instead of passing
     Mac config paths.
   - Tunnel safe Orchestrator bridge tool calls from remote sessions back to
     the coordinator.
   - Preserve spawn-depth stripping for `run_on_node`.
   - Add per-instance bridge tokens/capability descriptors and coordinator-side
     scope checks.
   - Ensure bridge credentials are not exposed in process command lines and are
     redacted from logs/artifacts.
   - Verify generated worker-local MCP config points to an executable/bundle
     present on the Windows worker in both dev and packaged installs.

3. **Bridge operation lifecycle**
   - Add a shared operation model for copy, sync, setup, test, dev-server, and
     remote browser work.
   - Add operation id/status/progress/cancel/query APIs and agent-facing status
     tools.
   - Add idempotency keys for mutating bridge actions and retry-safe status
     lookup.
   - Add output/event sequencing for terminal, test, dev-server, and
     browser-agent streams.
   - Add stale-operation reconciliation for worker disconnects and coordinator
     restarts.
   - Add cleanup/finalization paths for temp files, mutation locks, profile
     locks, child processes, and pending approvals/grants.

4. **Remote command/test workflow**
   - Add a higher-level `run_on_node` helper that accepts resolved workspace
     mapping and command/test intent.
   - Add command discovery or per-project config for browser test commands.
   - Add server reachability checks from the Windows node.
   - Add runtime/dependency preflight and approved setup command support.
   - Manage Windows dev-server startup as a child operation with readiness
     probes, port-conflict handling, bounded log capture, and cleanup/stop
     behavior.
   - Add provider-facing command output bounding, redaction, and local-only log
     artifact handling for setup/test/dev-server output.
   - Add structured command previews, argv-safe execution where possible,
     shell-mode approval, sanitized child environments, and remembered-command
     provenance checks.

5. **Remote Browser Gateway protocol**
   - Define browser-control RPC methods for Browser Gateway
     commands/results/events.
   - Add coordinator-side proxy and DTO validation.
   - Reuse existing Browser Gateway schemas where possible.
   - Add Zod-validated protocol version and capability negotiation for
     browser-control handshakes and requests.
   - Add persistence migrations and indexes for remote node/user-session scope
     across profiles, targets, approvals, grants, controller locks, and audit.
   - Add node-scoped profile/target/audit DTOs and remote observed-context
     inspection before mutating actions.
   - Add remote observation redaction, artifact storage/retention, and safe DTO
     projection rules for snapshots and screenshots.
   - Bind browser-control registration to the paired worker/node identity and
     reject self-declared or mismatched node identities.
   - Add node/user-session-scoped profile IDs, profile-controller locking, and
     remote disconnect cancellation semantics.
   - Add inspect-token/revision checks to prevent stale-context execution.

6. **Windows desktop browser agent**
   - Add a user-session process for the remote browser agent.
   - Store managed browser profiles under Windows user data, separate from the
     user's personal browser profile.
   - Report browser-agent health and profile availability to the coordinator.
   - Add startup/repair instructions for the logged-in Windows user session.
   - Register through an outbound browser-control connection with scoped,
     revocable credentials and protocol version reporting.

7. **Contract, packaging, and health checks**
   - Keep new contract subpaths synchronized across package exports, TypeScript
     aliases, Vitest aliases, and generated runtime aliases.
   - Add build/packaging checks for worker-local MCP and desktop browser-agent
     entrypoints.
   - Add Doctor/health output for missing bridge binaries, protocol mismatch,
     and browser-agent registration failures.
   - Add transport-security reporting and sensitive-capability gating for
     secret transfer, authenticated Browser Gateway, and observation artifacts.
   - Add revocation cascade behavior for node, browser-control, and per-instance
     bridge credentials.

8. **Agent discovery and UI**
   - Update Orchestrator tool descriptions for "Windows browser", "other PC",
     "copy .env", and "authenticated browser".
   - Add status/repair messaging in Remote Nodes and Browser Gateway surfaces.

## Acceptance Criteria

MVP file/test bridge:

- From a Mac project session, "copy my `.env` to Windows" copies only that file
  to the confirmed mapped workspace over protected transport and returns no
  secret contents.
- From a remote Windows session, the agent can still call bridge tools through
  worker-local MCP injection.
- Worker-local bridge tools are scoped by instance and cannot be reused by an
  unrelated process or different remote instance.
- Worker-local bridge config references only executables/bundles present on the
  Windows worker; no generated config contains Mac source or packaged resource
  paths.
- "Browser test this app on Windows" resolves the node, syncs safely, runs a
  configured or user-approved command on Windows, and streams output back.
- Browser test mode preflights dependencies/runtime and never uses the
  authenticated managed Browser Gateway profile by default.
- Browser test mode uses disposable/project test browser state unless a
  persistent test fixture is explicitly approved.
- Windows workspace paths preserve native separators/drive letters during copy,
  sync, and command execution.
- Remote writes reject symlink-parent escapes and do not leave partially written
  target files after failures.
- Sync refuses target-platform path collisions and invalid Windows target names
  during dry-run/preflight before writing any files.
- Repeated syncs detect target-side edits against the last successful baseline
  and refuse silent overwrite/delete until James resolves the conflict.
- Overlapping sync/copy/test mutations for the same mapped workspace are
  serialized or rejected with a clear "operation already running" result.
- Long-running copy/sync/setup/test/dev-server operations expose operation id,
  status, progress, timeout, cancellation, and safe final metadata.
- Retrying a mutating bridge operation with the same idempotency key does not
  duplicate writes, setup commands, test commands, dev-server launches, or
  browser actions.
- A Windows dev server started for browser testing is readiness-checked,
  conflict-aware, log-bounded, and stopped on completion/cancellation/failure
  unless James explicitly asks to keep it running.
- Setup/test/dev-server commands run from structured command definitions with
  sanitized environments and explicit shell-mode approval when shell execution
  is needed.
- Remote setup/test/dev-server output is bounded and redacted before provider
  exposure, with full logs kept only as local artifacts when needed.
- Worker disconnect or coordinator restart during a mutating operation does not
  silently rerun work; it surfaces stale/unknown state and blocks conflicting
  workspace mutations until reconciled.

Remote authenticated browser:

- Windows has a separate Orchestrator-managed browser profile.
- No cookies or browser profile data are copied from Mac.
- First login returns a manual-login-required result and resumes after James
  authenticates on Windows using a stable request id; no mutating action is
  auto-replayed after login.
- Mutating actions follow Browser Gateway classification, approval/grant, and
  audit rules with `nodeId` included.
- Remote profile IDs, grants, approvals, and audit entries are scoped by node
  and Windows user/session identity.
- Existing local Browser Gateway records do not match remote profile/grant
  records that reuse the same bare profile id.
- Remote screenshots and snapshots are redacted, bounded, and stored/referenced
  through artifact ids when persisted; raw screenshot bytes are not written to
  audit rows, logs, or transcripts.
- Authenticated remote Browser Gateway refuses to start over unprotected
  transport and reports repair guidance without disabling non-sensitive
  CLI/file/test workflows.
- Browser-control registration cannot impersonate another paired worker node.
- Browser-control and worker-local bridge protocol version mismatches disable
  only the affected capability and surface repair diagnostics.
- A remote profile already controlled elsewhere returns profile-busy or requires
  explicit user takeover.
- Remote browser control fails closed when the desktop browser agent is absent.
- Mutating actions do not execute if the remote page context changes between
  inspection/approval and execution.
- Mutating browser commands are not replayed automatically after browser-agent
  disconnect/reconnect.

## Testing

Focused unit tests:

- workspace mapping resolution and path validation
- explicit `.env` local-to-remote secret transfer redaction
- ordinary remote-fs still rejects restricted secret reads/writes
- dedicated secret-transfer path can write `.env` without enabling generic
  restricted-file `remote-fs` writes
- secret-transfer source symlink or source path outside the current workspace
  requires explicit confirmation before local read
- `copy_file_from_node` writes bytes to disk and returns metadata, not file
  contents
- MCP tool schema validation and tool descriptions
- contract alias/export synchronization for any added `@contracts/...` subpath
- transport-security classification gates secret transfer and authenticated
  Browser Gateway while allowing non-sensitive workflows
- remote-session worker-local MCP config generation does not contain Mac paths
- remote-session worker-local MCP config generation references an existing
  worker-local executable/bundle on Windows
- worker-local bridge token scoping rejects calls from the wrong instance
- worker-local bridge token invalidation on instance exit, hibernate, worker
  disconnect, and node revocation
- bridge credential redaction for command lines/logs/artifacts
- operation lifecycle state, progress, cancellation, timeout, and safe metadata
- idempotency-key retry handling for mutating copy/sync/setup/test/browser
  operations
- stale-operation reconciliation after worker disconnect or coordinator restart
- output/event sequence handling and sequence-gap reporting
- mutation lock recovery and release after cancellation, timeout, and stale
  operation reconciliation
- managed dev-server startup records process/session id, readiness probe,
  selected URL, parent test operation, and redacted log policy
- dev-server port conflict handling refuses to reuse/kill unknown processes
  without approval
- dev-server cleanup reports orphaned process state when termination fails
- Browser Gateway remote proxy DTO validation and error mapping
- browser-control and worker-local bridge protocol version negotiation
- Browser Gateway persistence migration preserves local records and scopes
  remote profiles/grants/approvals/audits by node and Windows user/session
- remote observation safe DTOs redact/truncate page text and do not expose raw
  screenshots by default
- screenshot artifact storage uses artifact ids, retention cleanup, and avoids
  raw bytes in audit/log output
- manual login and manual-step handoffs return stable request ids and expire
  stale requests
- worker capability reporting for desktop browser agent online/offline
- missing worker-local MCP/browser-agent entrypoint reports capability-specific
  unavailable health rather than crashing spawn
- browser-control registration rejects mismatched node identity or unissued
  browser-control credential
- browser-control credentials are revoked when the worker node is revoked
- remote profile id collisions across nodes do not match grants or audits
- profile-controller lock returns profile-busy for a second controller
- coordinator-side remote browser policy flow: inspect, classify, grant check,
  execute
- remote browser stale-context execution denial
- browser-agent disconnect cancels pending mutating action and requires fresh
  inspection before retry
- browser test mode does not use the authenticated managed profile without
  explicit approval
- sync dry-run and delete-protection defaults
- sync symlink escape prevention on local and remote sides
- endpoint-native remote path joining for Windows drive-letter and backslash
  paths
- target-platform path validation for Windows reserved names, invalid
  characters, trailing dots/spaces, alternate data stream syntax, and embedded
  nulls
- sync collision detection for case-insensitive and Unicode-normalized target
  paths before transfer/delete
- sync baseline storage and three-way conflict detection for target-side edits,
  two-sided edits, and missing-baseline first-sync behavior
- explicit conflict resolution modes for overwrite, keep target, backup then
  overwrite, and skip, with agents unable to choose destructive modes silently
- remote CLI cwd symlink escape rejection before spawn
- remote write nearest-parent symlink escape rejection before create/write
- atomic write behavior cleans up temp files and preserves the previous target
  on failure
- per-workspace mutation serialization for sync, copy, setup, and test command
- transfer size limit errors, plus streaming/chunking behavior if implemented
- structured command preview validation, argv-safe command construction,
  shell-mode approval, and sanitized child environment filtering
- remembered per-workspace command provenance invalidates confirmation when
  command source changes materially
- setup/test/dev-server output redaction and bounding, including detection of
  environment or restricted-file dumps in provider-facing output

Integration tests:

- local temp workspace syncs to a fake remote node root
- `copy_file_to_node` copies a secret without returning contents
- `copy_file_to_node` refuses secret transfer on unprotected transport and
  allows it on protected transport
- ordinary `remote-fs:write-file` still rejects `.env` after secret transfer is
  introduced
- remote-spawned instance receives bridge tools and can call a fake coordinator
  bridge method
- remote-spawned instance cannot use another instance's bridge token
- packaged/dev bridge-runtime resolution smoke test confirms generated worker
  MCP config and browser-agent launch paths exist on the worker side
- `run browser test on Windows` resolves node, syncs, runs command, and streams
  output in order
- browser-test command waits for the workspace sync/copy mutation lock before
  starting
- sync dry-run fails with a clear collision report for files that differ only
  by case or Windows path normalization
- sync dry-run fails before writing when a source entry maps to a Windows
  reserved device name or alternate data stream path
- repeated sync refuses to overwrite a Windows file changed since the last
  successful sync baseline
- repeated sync reports a two-sided conflict when both Mac and Windows copies
  changed since the baseline
- command preview rejects agent-supplied shell interpolation and accepts an
  argv-safe equivalent
- setup/test/dev-server child process does not inherit worker transport,
  browser-control, or bridge tokens in its environment
- browser-test output redacts likely tokens or dumped `.env` content before the
  fake provider-facing stream receives it
- cancelling a browser-test operation stops managed setup/test/dev-server child
  operations and releases the workspace mutation lock
- retrying a browser-test tool call with the same idempotency key returns the
  existing operation status rather than launching a second test/server
- a worker disconnect during setup/test marks the operation stale and does not
  silently rerun the command after reconnect
- dev-server readiness timeout prevents browser tests from running and cleans up
  the managed server
- dev-server port conflict with an unidentified process requires approval
  before reuse or termination
- remote Browser Gateway login-required result propagates to renderer approval
  and manual-step UI
- remote Browser Gateway manual-login request can be completed/polled by
  request id without keeping the browser-control RPC open
- remote Browser Gateway mutating action requires coordinator approval before
  the fake remote browser agent receives an execute command
- remote Browser Gateway refuses execution when the fake remote browser context
  changes after approval
- remote Browser Gateway audit rows reference screenshot artifact ids instead
  of storing screenshot bytes
- remote Browser Gateway refuses browser-agent registration for a fake node id
  that is not bound to the paired worker identity
- remote Browser Gateway refuses authenticated profile control on unprotected
  transport but leaves ordinary remote CLI/file/test flows available
- revoking a node invalidates browser-control credentials, pending remote
  approvals/grants, profile-controller locks, and worker-local bridge tokens
- remote Browser Gateway does not replay a pending click/type/fill after the
  fake browser-control connection drops and reconnects

Verification after implementation:

1. Run `npm run generate:aliases`, `npm run verify:exports`, and
   `npm run check:contracts` after any contract or alias changes.
2. Run `npm run build:worker-agent` and `npm run build:aio-mcp-dist` after
   adding worker-local MCP or browser-agent entrypoints.
3. Run focused Vitest files for remote-node, remote-fs, orchestrator tools,
   Browser Gateway proxy, and worker browser agent.
4. Run `npx tsc --noEmit`.
5. Run `npx tsc --noEmit -p tsconfig.spec.json`.
6. Run lint on modified files or `npm run lint` for broad changes.
7. Manually verify with a paired Windows node:
   - copy `.env`
   - sync workspace
   - run a browser test command
   - open the Windows managed browser profile
   - complete a manual login handoff
   - perform a non-destructive authenticated browser action
   - confirm sensitive operations refuse unprotected transport and work over
     protected transport

## Risks

- Browser automation from a Windows service will fail or behave unsafely if it
  runs outside the interactive desktop. The desktop browser agent must be a
  separate user-session process.
- Remote Browser Gateway can duplicate local Browser Gateway logic if the
  boundary is wrong. Prefer shared schemas and a coordinator proxy that reuses
  existing policy/audit concepts.
- Authenticated browser observations can leak sensitive account data through
  screenshots, snapshots, approval context, or audit artifacts. Treat all
  remote observations as sensitive, redact/limit provider-facing DTOs, and keep
  artifact retention explicit.
- Plain LAN WebSocket transport can expose secrets or authenticated browser
  observations even when application-level authorization is correct. Gate
  sensitive bridge capabilities on protected transport and make downgrade
  states visible.
- Secret transfer can leak if results or logs include file contents. Treat
  secret file bytes as write-only payloads and return metadata only.
- Path mapping can surprise users if inferred incorrectly. First-time mappings
  should be visible and confirmable.
- Cross-platform sync can corrupt or overwrite files when source paths collide
  on the Windows target. Detect target-platform path collisions during preflight
  and require user resolution before transfer.
- Repeated one-way sync can overwrite Windows-side edits if it compares only
  source and target. Keep a last-successful-sync baseline and require explicit
  conflict resolution for target-side or two-sided edits.
- Concurrent workspace mutations can create hard-to-debug test failures or
  partial remote workspaces. Serialize writes per mapping and surface active
  operation state.
- Long-running remote operations can outlive the coordinator request that
  started them. Without operation ids, idempotency, cancellation, and cleanup,
  retries can duplicate writes/tests/browser actions or leave orphaned Windows
  dev servers.
- Remote command/test output can leak secrets after `.env` transfer or during
  dependency setup. Bound and redact provider-facing logs, and keep full
  diagnostics local-only with explicit retention.
- Remote setup/test/dev-server commands can inherit worker-service credentials
  or turn agent-provided values into shell behavior. Use structured command
  definitions, sanitized child environments, argv-safe spawning, and explicit
  shell-mode approval.
- Worker-local bridge tokens become sensitive because they authorize scoped
  coordinator operations. Keep them short-lived, per-instance, redacted from
  logs, and invalidated when the remote instance terminates.
- Direct browser-agent registration adds a second remote connection per
  Windows machine. Keep credentials scoped and revocable so losing browser
  control does not imply losing CLI/filesystem control.
- Contract aliases and packaged bridge resources can pass local typecheck while
  failing only in packaged Electron or on the Windows worker. Keep contract
  sync, generated runtime aliases, and worker/browser-agent resource checks in
  the implementation verification path.
