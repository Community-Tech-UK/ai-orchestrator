# Remote Folder Browsing

**Date**: 2026-04-07
**Status**: Draft
**Scope**: Enable users to browse, search, and select working directories on remote worker nodes with the same ease as local folder selection.

## Problem

When a user selects a remote node (e.g. Windows PC) to run a session on, they have no way to browse that machine's filesystem to pick a working directory. The existing folder selection UI only shows local directories. The remote node already connects and declares capabilities, but filesystem browsing is not part of the protocol.

## Design Goals

- **Seamless experience**: Selecting a folder on a remote node should feel the same as selecting one locally — pick from recents, browse for new ones, search by name.
- **Security by default**: Remote filesystem access is scoped to declared roots with symlink escape prevention.
- **Cross-platform**: Windows, macOS, and Linux nodes are all first-class. Paths display in each platform's native format.
- **Responsive over network**: Caching, prefetching, and push-based invalidation mask network latency.

## Architecture Overview

Three layers deliver the feature:

1. **RPC Protocol** — Four new `fs.*` methods on the coordinator-to-node channel.
2. **Node-side Handler** — Filesystem operations scoped to browsable roots, with project auto-discovery.
3. **UI** — Node-aware dropdown, browse modal (tree + fuzzy search), and remote-capable FILES panel.

A `FilesystemService` in the main process routes all filesystem calls: local paths go to Node.js `fs`, remote paths go through the RPC layer. The Angular frontend never needs to know where a path lives.

## 1. Path Model

### Internal Representation

All paths are stored as **native-format strings** tagged with a node ID:

```typescript
interface RemotePath {
  nodeId: string;       // UUID of the worker node, or 'local'
  path: string;         // Native path as the node reports it
  platform: NodePlatform; // 'win32' | 'darwin' | 'linux'
}
```

### Wire Format

Paths travel over RPC in their **native format** — Windows nodes send backslashes and drive letters, POSIX nodes send forward slashes. The node owns its paths; the coordinator stores and displays them as-is.

**Rationale**: Normalizing paths on the wire (e.g. always forward slashes) creates a translation layer that must handle drive letters, UNC paths, and WSL paths correctly. Keeping native format means the node can use paths directly without conversion, and the coordinator only needs display formatting.

### Display

An Angular pipe (`nodePath`) formats paths for display:
- Windows paths render with `\` separators and preserve drive letters
- macOS/Linux paths render with `/` as-is
- Remote paths show a platform icon badge and node name

### Recent Directories Storage

Remote entries in the recent directories store are namespaced by node ID:

```typescript
interface RecentDirectoryEntry {
  path: string;
  nodeId: string;        // 'local' for local dirs
  platform: NodePlatform;
  pinned: boolean;
  lastAccessed: number;
  displayName?: string;
}
```

When the dropdown opens and a remote node is selected, it filters to entries matching that node ID plus any auto-discovered projects from the node's capabilities.

## 2. RPC Protocol

### New Methods

Four new coordinator-to-node methods, added to `COORDINATOR_TO_NODE` in `worker-node-rpc.ts`:

#### `fs.readDirectory`

Browse a directory's contents with inline stat data.

**Request:**
```typescript
interface FsReadDirectoryParams {
  path: string;           // Native path on the node
  depth?: number;         // 1-3, default 1. Depth 2 prefetches one level ahead.
  includeHidden?: boolean; // Default false
  cursor?: string;        // Opaque cursor for pagination
  limit?: number;         // Max entries per page, default 500
}
```

**Response:**
```typescript
interface FsReadDirectoryResult {
  entries: FsEntry[];
  cursor?: string;        // Present if more entries available
  truncated: boolean;     // True if directory exceeds limit
}

interface FsEntry {
  name: string;
  path: string;           // Full native path
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number;     // Unix timestamp ms
  extension?: string;
  ignored: boolean;       // Matched .gitignore
  restricted: boolean;    // Matched security blocklist (.env, .ssh/, etc.)
  children?: FsEntry[];   // Present when depth > 1
}
```

#### `fs.stat`

Validate a single path exists and is accessible. Used for JIT validation before session launch.

**Request:**
```typescript
interface FsStatParams {
  path: string;
}
```

**Response:**
```typescript
interface FsStatResult {
  exists: boolean;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  platform: NodePlatform;
  withinBrowsableRoot: boolean;
}
```

#### `fs.search`

Fuzzy project finder. Searches within browsable roots for directories matching a query.

**Request:**
```typescript
interface FsSearchParams {
  query: string;          // Fuzzy match against directory names
  maxResults?: number;    // Default 20
}
```

**Response:**
```typescript
interface FsSearchResult {
  results: FsProjectMatch[];
}

interface FsProjectMatch {
  path: string;           // Full native path
  name: string;           // Directory name
  markers: string[];      // e.g. ['.git', 'package.json', 'Cargo.toml']
  root: string;           // Which browsable root it's under
}
```

#### `fs.watch`

Subscribe to filesystem changes in a directory. The node pushes `fs.event` notifications over the WebSocket. Used by the FILES panel for live updates.

**Request:**
```typescript
interface FsWatchParams {
  path: string;
  recursive?: boolean;    // Default false
}
```

**Response:**
```typescript
interface FsWatchResult {
  watchId: string;        // Used to unsubscribe
}
```

**Notifications** (node-to-coordinator, pushed via JSON-RPC notification):
```typescript
interface FsEventNotification {
  watchId: string;
  events: Array<{
    type: 'add' | 'change' | 'delete';
    path: string;
    isDirectory: boolean;
  }>;
}
```

**Unsubscribe**: `fs.unwatch` with `{ watchId: string }`. Auto-cleanup on WebSocket disconnect.

### Error Schema

All `fs.*` methods use a structured error format extending JSON-RPC:

```typescript
{
  code: -32001,
  message: 'Filesystem error',
  data: {
    fsCode: 'ENOENT' | 'EACCES' | 'EOUTOFSCOPE' | 'ETIMEOUT' | 'ENOTDIR',
    path: string,
    retryable: boolean,
    suggestion?: string
  }
}
```

- `EOUTOFSCOPE` — Path resolves outside browsable roots (e.g. symlink escape). Includes suggestion: "Path is outside browsable roots. Add the target directory as a root in node configuration."
- `ETIMEOUT` — Node took too long to respond to a filesystem operation.

### Security

- **Browsable roots**: Each node declares `browsableRoots: string[]` in its configuration. All `fs.*` methods are scoped to these roots.
- **realpath() enforcement**: Every path parameter is resolved via `realpath()` before any filesystem operation. If the resolved path is not a descendant of a declared root, the node returns `EOUTOFSCOPE`.
- **Sensitive file filtering**: Node parses `.gitignore` at each root. Files matching a security blocklist (`.env`, `.ssh/`, private keys, credential files) are flagged `restricted: true` — visible in listings but content is not readable without explicit user confirmation.
- **No write operations**: This design is read-only. No file creation, deletion, or modification via RPC. The AI CLI instances handle file operations within their sessions.

## 3. Node-Side Implementation

### Configuration

Nodes declare browsable roots in their configuration:

```typescript
interface WorkerNodeConfig {
  // ... existing fields ...
  browsableRoots: string[];  // e.g. ['C:\\Projects', 'D:\\repos']
}
```

If `browsableRoots` is empty or unconfigured, the node defaults to the user's home directory as the single browsable root. Auto-discovery runs within whichever roots are active (including the home directory fallback).

### Capabilities Extension

The existing `WorkerNodeCapabilities` type gains:

```typescript
interface WorkerNodeCapabilities {
  // ... existing fields ...
  browsableRoots: string[];            // Declared browsable roots
  discoveredProjects: DiscoveredProject[]; // Auto-found project dirs
}

interface DiscoveredProject {
  path: string;
  name: string;
  markers: string[];
}
```

These are sent in the heartbeat, so the coordinator always has an up-to-date list of quick-access project folders.

### Auto-Discovery

On startup and every 5 minutes, the node scans each browsable root (max depth 4) for directories containing project markers:

- `.git`
- `package.json`
- `Cargo.toml`
- `go.mod`
- `pyproject.toml` / `requirements.txt`
- `.sln` / `.csproj`
- `pom.xml` / `build.gradle`

The scan skips `node_modules`, `.git`, `dist`, `build`, `target`, and other known heavy directories. Results are cached in memory and sent with each heartbeat.

### Filesystem Handler

A `NodeFilesystemHandler` class implements the four `fs.*` methods:

1. Receives RPC request
2. Resolves path via `realpath()`
3. Validates resolved path is within a browsable root
4. Performs the filesystem operation
5. Applies `.gitignore` and security filters to results
6. Returns structured response or error

For `fs.watch`, uses `chokidar` (or Node.js native `fs.watch` with a debounce wrapper) scoped to the requested directory. Watchers are stored in a map keyed by `watchId` and cleaned up on unsubscribe or WebSocket disconnect.

## 4. UI — Node-Aware Dropdown

### Behavior Change

The existing `RecentDirectoriesDropdownComponent` becomes node-aware:

- **Input**: New `selectedNodeId` input signal from the parent (instance-detail/welcome component)
- **Data source**: When `selectedNodeId` is `null` or `'local'`, behavior is unchanged (local recent dirs + Electron dialog). When set to a remote node ID, the dropdown shows:
  1. **Pinned remote dirs** — Previously used directories on this node
  2. **Discovered projects** — From the node's heartbeat capabilities
  3. **Recent remote dirs** — Previously accessed directories on this node
  4. **"Browse [node-name]..."** — Opens the browse modal
  5. **"Search [node-name]..."** — Opens fuzzy finder mode in the modal
- **"Browse..." routing**: For local nodes, opens Electron's native `dialog.showOpenDialog()` as before. For remote nodes, opens the new browse modal component.

### Remote Entry Display

Remote entries in the dropdown show:
- Platform icon (Windows/macOS/Linux) as a small badge
- Path in native format
- Node name in muted text (when viewing mixed local+remote recents)

## 5. UI — Browse Modal

A new `RemoteBrowseModalComponent` for browsing remote filesystems when the user needs to find a new folder.

### Layout

- **Header**: Breadcrumb path bar. Each path segment is clickable for quick navigation up the tree. Shows the node name and platform icon.
- **Mode toggle**: Switch between "Browse" (tree view) and "Search" (fuzzy finder)
- **Body (Browse mode)**: Directory listing using the same `FsEntry` rendering as the FILES panel. Click a folder to navigate into it. Directories load lazily via `fs.readDirectory`.
- **Body (Search mode)**: Text input with real-time results from `fs.search`. Each result shows the project name, path, and detected markers (icons for git, npm, cargo, etc.).
- **Footer**: "Select" button (enabled when a directory is highlighted) and "Cancel".

### Loading States

- **< 100ms**: Instant render, no indicator
- **100-500ms**: Skeleton shimmer on directory entries
- **> 500ms**: Explicit spinner with latency display (e.g. "Loading... 1.2s")

### Entry Point

The browse modal opens from:
1. The "Browse [node-name]..." option in the dropdown
2. The "Search [node-name]..." option in the dropdown (opens directly in search mode)

On selection, the chosen path is emitted back to the welcome component, added to recent dirs (namespaced to the node), and used as the session's working directory.

## 6. UI — FILES Panel Extension

### Routing

The existing `FileExplorerComponent` gains remote awareness:

- New input or injected context: the active instance's execution location (`{ type: 'local' } | { type: 'remote', nodeId: string }`)
- When `type === 'local'`: Behavior unchanged — uses Electron IPC `readDir` calls to local `fs`.
- When `type === 'remote'`: Routes `readDir` through the `FilesystemService`, which sends `fs.readDirectory` RPC to the appropriate node.

### Live Updates

- Local: Uses existing file watchers (unchanged)
- Remote: Subscribes via `fs.watch` RPC when the panel opens for a remote instance. Unsubscribes on panel close or instance switch. Change events update the cached tree in real-time.

### Visual Indicator

- Panel header shows a node badge when browsing remote files (platform icon + node name)
- Entries flagged `restricted: true` show a lock icon and are not openable without confirmation
- Entries flagged `ignored: true` render with reduced opacity (same as local gitignored files)

## 7. Caching & Performance

### Client-Side Cache

- **LRU cache** in the main process `FilesystemService`, keyed by `nodeId:path`
- **TTL**: 30 seconds for directory listings
- **Instant invalidation**: `fs.watch` events bypass TTL — when the FILES panel pushes a change event, the corresponding cache entry is invalidated immediately
- **Cache on browse**: When the user navigates in the browse modal, results are cached so "back" navigation is instant

### Prefetching

- Browse modal requests `depth: 2` — fetches current directory + one level of children. The next click is instant from cache.
- Dropdown requests `depth: 1` only (lightweight, just for listing).

### Project Index

- Node-side project discovery index is rebuilt every 5 minutes in the background
- `fs.search` queries the index first, falls back to live scan only if no matches
- Index is lightweight (paths + markers only, no file contents)

### Large Directories

- Cursor-based pagination at 500 entries per page
- `truncated: true` flag in response when more entries exist
- UI shows "Load more..." button at the bottom of truncated listings

## 8. Error Handling

| Scenario | Behavior |
|----------|----------|
| Node disconnects mid-browse | Modal/FILES panel shows "Node disconnected" banner with retry button. Cached data remains visible but grayed out. |
| Path outside browsable roots | Inline error: "This path is outside the node's browsable roots." with link to node settings. |
| Permission denied on remote folder | Entry shows lock icon. Tooltip: "Permission denied on [node-name]." |
| Timeout (> 10s) | Abort request. Show "Request timed out. The node may be under heavy load." with retry. |
| Node has no browsable roots configured | Dropdown shows: "No browsable roots configured on [node-name]. Using home directory." Falls back to home dir. |
| Selected remote path no longer exists at session launch | JIT `fs.stat` check catches this. Error: "Directory not found on [node-name]. It may have been moved or deleted." |

## 9. Implementation Scope

### In Scope

- RPC protocol: 4 new `fs.*` methods + `fs.event` notifications + Zod schemas
- Node-side: `NodeFilesystemHandler` with `realpath()` security, `.gitignore` filtering, project auto-discovery
- Capabilities extension: `browsableRoots` + `discoveredProjects` in heartbeat
- UI: Node-aware dropdown, `RemoteBrowseModalComponent` (tree + search), FILES panel remote routing
- Recent dirs: Namespaced by node ID, cross-platform display
- Caching: LRU cache with watch-based invalidation
- `FilesystemService`: Routing layer in main process

### Out of Scope

- Remote file editing/writing (read-only browsing only)
- Remote terminal access
- File transfer between nodes
- Coordinator-side browsable roots configuration UI (node configures its own roots)
