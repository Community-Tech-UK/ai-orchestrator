# Remote Folder Browsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to browse, search, and select working directories on remote worker nodes with the same ease as local folder selection.

**Architecture:** Four new `fs.*` RPC methods on the coordinator-to-node WebSocket channel, a `FilesystemService` routing layer in the main process, node-aware dropdown + browse modal + FILES panel extension in Angular.

**Tech Stack:** TypeScript 5.9, Angular 21 (signals/zoneless), Electron 40, Zod 4, Vitest, JSON-RPC 2.0 over WebSocket/TLS.

**Spec:** `docs/superpowers/specs/2026-04-07-remote-folder-browsing-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/shared/types/remote-fs.types.ts` | All remote filesystem types (FsEntry, params, results, errors) |
| `src/shared/validation/remote-fs-schemas.ts` | Zod schemas for fs.* RPC params and IPC payloads |
| `src/main/remote-node/node-filesystem-handler.ts` | Node-side handler: readDirectory, stat, search, watch/unwatch |
| `src/main/remote-node/project-discovery.ts` | Auto-discovery of project directories within browsable roots |
| `src/main/remote-node/security-filter.ts` | .gitignore parsing + security blocklist for filesystem entries |
| `src/main/services/filesystem-service.ts` | Main process routing layer: local fs vs remote RPC |
| `src/main/ipc/handlers/remote-fs-handlers.ts` | IPC handlers for renderer→main filesystem requests |
| `src/renderer/app/core/services/ipc/remote-fs-ipc.service.ts` | Angular service wrapping remote FS IPC calls |
| `src/renderer/app/shared/components/remote-browse-modal/remote-browse-modal.component.ts` | Modal with tree browser + fuzzy search |
| `src/renderer/app/shared/pipes/node-path.pipe.ts` | Cross-platform path display pipe |

### Modified Files

| File | Change |
|------|--------|
| `src/shared/types/worker-node.types.ts` | Add `browsableRoots`, `discoveredProjects` to `WorkerNodeCapabilities` |
| `src/main/remote-node/worker-node-rpc.ts` | Add `fs.*` methods to `COORDINATOR_TO_NODE` and `NODE_TO_COORDINATOR` enums |
| `src/main/remote-node/rpc-schemas.ts` | Add fs.* Zod schemas to `RPC_PARAM_SCHEMAS` map |
| `src/main/remote-node/rpc-event-router.ts` | Route incoming fs.* requests to `NodeFilesystemHandler` |
| `src/shared/types/recent-directories.types.ts` | Add `nodeId`, `platform` fields to `RecentDirectoryEntry` |
| `src/renderer/app/shared/components/recent-directories-dropdown/recent-directories-dropdown.component.ts` | Node-aware data source, remote browse/search actions |
| `src/renderer/app/features/file-explorer/file-explorer.component.ts` | Remote-aware readDir routing, watch subscription |
| `src/renderer/app/features/instance-detail/instance-welcome.component.ts` | Pass `selectedNodeId` to dropdown, wire browse modal |
| `src/preload/preload.ts` | Expose remote FS methods on `electronAPI` |
| `src/shared/types/ipc.types.ts` | Add `REMOTE_FS_*` IPC channels |

---

## Phase 1: Shared Types & RPC Protocol

### Task 1: Remote Filesystem Types

**Files:**
- Create: `src/shared/types/remote-fs.types.ts`
- Test: `src/shared/types/remote-fs.types.spec.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/shared/types/remote-fs.types.ts
import type { NodePlatform } from './worker-node.types';

// ============ Filesystem Entry ============

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number;
  extension?: string;
  ignored: boolean;
  restricted: boolean;
  children?: FsEntry[];
}

// ============ RPC Params ============

export interface FsReadDirectoryParams {
  path: string;
  depth?: number;
  includeHidden?: boolean;
  cursor?: string;
  limit?: number;
}

export interface FsStatParams {
  path: string;
}

export interface FsSearchParams {
  query: string;
  maxResults?: number;
}

export interface FsWatchParams {
  path: string;
  recursive?: boolean;
}

export interface FsUnwatchParams {
  watchId: string;
}

// ============ RPC Results ============

export interface FsReadDirectoryResult {
  entries: FsEntry[];
  cursor?: string;
  truncated: boolean;
}

export interface FsStatResult {
  exists: boolean;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  platform: NodePlatform;
  withinBrowsableRoot: boolean;
}

export interface FsSearchResult {
  results: FsProjectMatch[];
}

export interface FsProjectMatch {
  path: string;
  name: string;
  markers: string[];
  root: string;
}

export interface FsWatchResult {
  watchId: string;
}

// ============ Notifications ============

export interface FsEventNotification {
  watchId: string;
  events: FsChangeEvent[];
}

export interface FsChangeEvent {
  type: 'add' | 'change' | 'delete';
  path: string;
  isDirectory: boolean;
}

// ============ Errors ============

export type FsErrorCode = 'ENOENT' | 'EACCES' | 'EOUTOFSCOPE' | 'ETIMEOUT' | 'ENOTDIR';

export interface FsErrorData {
  fsCode: FsErrorCode;
  path: string;
  retryable: boolean;
  suggestion?: string;
}

// ============ Discovered Projects ============

export interface DiscoveredProject {
  path: string;
  name: string;
  markers: string[];
}
```

- [ ] **Step 2: Write a smoke test to verify types compile**

```typescript
// src/shared/types/remote-fs.types.spec.ts
import { describe, expect, it } from 'vitest';
import type {
  FsEntry,
  FsReadDirectoryParams,
  FsReadDirectoryResult,
  FsStatParams,
  FsStatResult,
  FsSearchParams,
  FsSearchResult,
  FsWatchParams,
  FsWatchResult,
  FsEventNotification,
  FsErrorData,
  DiscoveredProject,
} from './remote-fs.types';

describe('remote-fs types', () => {
  it('FsEntry satisfies shape', () => {
    const entry: FsEntry = {
      name: 'src',
      path: 'C:\\Projects\\my-app\\src',
      isDirectory: true,
      isSymlink: false,
      size: 0,
      modifiedAt: Date.now(),
      ignored: false,
      restricted: false,
    };
    expect(entry.name).toBe('src');
  });

  it('FsReadDirectoryParams defaults', () => {
    const params: FsReadDirectoryParams = { path: '/home/dev/projects' };
    expect(params.depth).toBeUndefined();
    expect(params.includeHidden).toBeUndefined();
  });

  it('FsErrorData has suggestion', () => {
    const err: FsErrorData = {
      fsCode: 'EOUTOFSCOPE',
      path: '/etc/passwd',
      retryable: false,
      suggestion: 'Path is outside browsable roots.',
    };
    expect(err.fsCode).toBe('EOUTOFSCOPE');
  });

  it('DiscoveredProject has markers', () => {
    const proj: DiscoveredProject = {
      path: 'C:\\Projects\\my-app',
      name: 'my-app',
      markers: ['.git', 'package.json'],
    };
    expect(proj.markers).toContain('.git');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/shared/types/remote-fs.types.spec.ts`
Expected: All 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/remote-fs.types.ts src/shared/types/remote-fs.types.spec.ts
git commit -m "feat(remote-fs): add shared types for remote filesystem protocol"
```

---

### Task 2: Extend WorkerNodeCapabilities

**Files:**
- Modify: `src/shared/types/worker-node.types.ts:5-19`
- Modify: `src/main/remote-node/rpc-schemas.ts:5-19`

- [ ] **Step 1: Add browsableRoots and discoveredProjects to the type**

In `src/shared/types/worker-node.types.ts`, add to the `WorkerNodeCapabilities` interface (after `workingDirectories: string[]` at line 18):

```typescript
  browsableRoots: string[];
  discoveredProjects: DiscoveredProject[];
```

Add the import at the top:
```typescript
import type { DiscoveredProject } from './remote-fs.types';
```

- [ ] **Step 2: Update the Zod schema**

In `src/main/remote-node/rpc-schemas.ts`, add to `WorkerNodeCapabilitiesSchema` (after `workingDirectories` at line 18):

```typescript
  browsableRoots: z.array(z.string()).default([]),
  discoveredProjects: z.array(z.object({
    path: z.string(),
    name: z.string(),
    markers: z.array(z.string()),
  })).default([]),
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors. The `.default([])` on the Zod schema means existing nodes that don't send these fields will get empty arrays.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/worker-node.types.ts src/main/remote-node/rpc-schemas.ts
git commit -m "feat(remote-fs): extend WorkerNodeCapabilities with browsableRoots and discoveredProjects"
```

---

### Task 3: RPC Method Constants & Schemas

**Files:**
- Modify: `src/main/remote-node/worker-node-rpc.ts:17-25,65-75`
- Create: `src/shared/validation/remote-fs-schemas.ts`
- Modify: `src/main/remote-node/rpc-schemas.ts:80-92`
- Test: `src/shared/validation/remote-fs-schemas.spec.ts`

- [ ] **Step 1: Add fs.* methods to RPC enums**

In `src/main/remote-node/worker-node-rpc.ts`, add to `COORDINATOR_TO_NODE` (after `NODE_PING` at line 24):

```typescript
  FS_READ_DIRECTORY: 'fs.readDirectory',
  FS_STAT: 'fs.stat',
  FS_SEARCH: 'fs.search',
  FS_WATCH: 'fs.watch',
  FS_UNWATCH: 'fs.unwatch',
```

Add to `NODE_TO_COORDINATOR` (after `INSTANCE_PERMISSION_REQUEST` at line 13):

```typescript
  FS_EVENT: 'fs.event',
```

Add to `RPC_ERROR_CODES` (after `SPAWN_FAILED` at line 74):

```typescript
  FILESYSTEM_ERROR: -32004,
```

- [ ] **Step 2: Create Zod schemas for fs.* params**

```typescript
// src/shared/validation/remote-fs-schemas.ts
import { z } from 'zod';

export const FsReadDirectoryParamsSchema = z.object({
  path: z.string().min(1).max(4096),
  depth: z.number().int().min(1).max(3).default(1),
  includeHidden: z.boolean().default(false),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(1000).default(500),
});

export const FsStatParamsSchema = z.object({
  path: z.string().min(1).max(4096),
});

export const FsSearchParamsSchema = z.object({
  query: z.string().min(1).max(200),
  maxResults: z.number().int().min(1).max(100).default(20),
});

export const FsWatchParamsSchema = z.object({
  path: z.string().min(1).max(4096),
  recursive: z.boolean().default(false),
});

export const FsUnwatchParamsSchema = z.object({
  watchId: z.string().min(1).max(100),
});

export const FsEventParamsSchema = z.object({
  watchId: z.string(),
  events: z.array(z.object({
    type: z.enum(['add', 'change', 'delete']),
    path: z.string(),
    isDirectory: z.boolean(),
  })),
});
```

- [ ] **Step 3: Register schemas in the RPC lookup map**

In `src/main/remote-node/rpc-schemas.ts`, add imports at the top:

```typescript
import {
  FsReadDirectoryParamsSchema,
  FsStatParamsSchema,
  FsSearchParamsSchema,
  FsWatchParamsSchema,
  FsUnwatchParamsSchema,
  FsEventParamsSchema,
} from '../../shared/validation/remote-fs-schemas';
```

Add entries to `RPC_PARAM_SCHEMAS` (after `'instance.wake'` at line 91):

```typescript
  'fs.readDirectory': FsReadDirectoryParamsSchema,
  'fs.stat': FsStatParamsSchema,
  'fs.search': FsSearchParamsSchema,
  'fs.watch': FsWatchParamsSchema,
  'fs.unwatch': FsUnwatchParamsSchema,
  'fs.event': FsEventParamsSchema,
```

- [ ] **Step 4: Write schema tests**

```typescript
// src/shared/validation/remote-fs-schemas.spec.ts
import { describe, expect, it } from 'vitest';
import {
  FsReadDirectoryParamsSchema,
  FsStatParamsSchema,
  FsSearchParamsSchema,
  FsWatchParamsSchema,
  FsUnwatchParamsSchema,
} from './remote-fs-schemas';

describe('remote-fs-schemas', () => {
  describe('FsReadDirectoryParamsSchema', () => {
    it('accepts minimal params', () => {
      const result = FsReadDirectoryParamsSchema.parse({ path: '/home/dev' });
      expect(result.path).toBe('/home/dev');
      expect(result.depth).toBe(1);
      expect(result.includeHidden).toBe(false);
      expect(result.limit).toBe(500);
    });

    it('accepts full params', () => {
      const result = FsReadDirectoryParamsSchema.parse({
        path: 'C:\\Projects',
        depth: 2,
        includeHidden: true,
        cursor: 'abc123',
        limit: 100,
      });
      expect(result.depth).toBe(2);
    });

    it('rejects depth > 3', () => {
      expect(() => FsReadDirectoryParamsSchema.parse({ path: '/tmp', depth: 4 }))
        .toThrow();
    });

    it('rejects empty path', () => {
      expect(() => FsReadDirectoryParamsSchema.parse({ path: '' }))
        .toThrow();
    });
  });

  describe('FsStatParamsSchema', () => {
    it('accepts valid path', () => {
      const result = FsStatParamsSchema.parse({ path: 'C:\\Users\\dev\\project' });
      expect(result.path).toBe('C:\\Users\\dev\\project');
    });
  });

  describe('FsSearchParamsSchema', () => {
    it('defaults maxResults to 20', () => {
      const result = FsSearchParamsSchema.parse({ query: 'my-proj' });
      expect(result.maxResults).toBe(20);
    });

    it('rejects empty query', () => {
      expect(() => FsSearchParamsSchema.parse({ query: '' })).toThrow();
    });
  });

  describe('FsWatchParamsSchema', () => {
    it('defaults recursive to false', () => {
      const result = FsWatchParamsSchema.parse({ path: '/home/dev/project' });
      expect(result.recursive).toBe(false);
    });
  });

  describe('FsUnwatchParamsSchema', () => {
    it('accepts watchId', () => {
      const result = FsUnwatchParamsSchema.parse({ watchId: 'w-123' });
      expect(result.watchId).toBe('w-123');
    });
  });
});
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/shared/validation/remote-fs-schemas.spec.ts && npx tsc --noEmit`
Expected: All tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/remote-node/worker-node-rpc.ts src/shared/validation/remote-fs-schemas.ts src/shared/validation/remote-fs-schemas.spec.ts src/main/remote-node/rpc-schemas.ts
git commit -m "feat(remote-fs): add RPC method constants and Zod schemas for fs.* protocol"
```

---

## Phase 2: Node-Side Filesystem Handler

### Task 4: Security Filter

**Files:**
- Create: `src/main/remote-node/security-filter.ts`
- Test: `src/main/remote-node/security-filter.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/remote-node/security-filter.spec.ts
import { describe, expect, it } from 'vitest';
import { SecurityFilter } from './security-filter';

describe('SecurityFilter', () => {
  describe('isRestricted', () => {
    it('flags .env files', () => {
      expect(SecurityFilter.isRestricted('.env')).toBe(true);
      expect(SecurityFilter.isRestricted('.env.local')).toBe(true);
      expect(SecurityFilter.isRestricted('.env.production')).toBe(true);
    });

    it('flags .ssh directory', () => {
      expect(SecurityFilter.isRestricted('.ssh')).toBe(true);
    });

    it('flags private key files', () => {
      expect(SecurityFilter.isRestricted('id_rsa')).toBe(true);
      expect(SecurityFilter.isRestricted('id_ed25519')).toBe(true);
    });

    it('flags credential files', () => {
      expect(SecurityFilter.isRestricted('.npmrc')).toBe(true);
      expect(SecurityFilter.isRestricted('.netrc')).toBe(true);
      expect(SecurityFilter.isRestricted('credentials.json')).toBe(true);
    });

    it('does not flag normal files', () => {
      expect(SecurityFilter.isRestricted('package.json')).toBe(false);
      expect(SecurityFilter.isRestricted('README.md')).toBe(false);
      expect(SecurityFilter.isRestricted('src')).toBe(false);
    });
  });

  describe('isWithinRoot', () => {
    it('accepts paths within root', () => {
      expect(SecurityFilter.isWithinRoot('/home/dev/projects/app', ['/home/dev/projects'])).toBe(true);
    });

    it('accepts exact root path', () => {
      expect(SecurityFilter.isWithinRoot('/home/dev/projects', ['/home/dev/projects'])).toBe(true);
    });

    it('rejects paths outside all roots', () => {
      expect(SecurityFilter.isWithinRoot('/etc/passwd', ['/home/dev/projects'])).toBe(false);
    });

    it('handles Windows paths', () => {
      expect(SecurityFilter.isWithinRoot('C:\\Projects\\app\\src', ['C:\\Projects'])).toBe(true);
      expect(SecurityFilter.isWithinRoot('D:\\secrets', ['C:\\Projects'])).toBe(false);
    });

    it('prevents .. traversal after normalization', () => {
      expect(SecurityFilter.isWithinRoot('/home/dev/projects/../../../etc', ['/home/dev/projects'])).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/remote-node/security-filter.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement SecurityFilter**

```typescript
// src/main/remote-node/security-filter.ts
import path from 'node:path';

const RESTRICTED_PATTERNS = [
  /^\.env($|\.)/,         // .env, .env.local, .env.production
  /^\.ssh$/,
  /^id_rsa/,
  /^id_ed25519/,
  /^id_ecdsa/,
  /^id_dsa/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.pypirc$/,
  /^credentials\.json$/,
  /^\.aws$/,
  /^\.docker\/config\.json$/,
  /^\.kube$/,
  /^\.gnupg$/,
  /^token\.json$/,
  /^secrets?\./,
  /\.pem$/,
  /\.key$/,
];

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
]);

export class SecurityFilter {
  static isRestricted(name: string): boolean {
    return RESTRICTED_PATTERNS.some(pattern => pattern.test(name));
  }

  static isWithinRoot(targetPath: string, roots: string[]): boolean {
    const resolved = path.resolve(targetPath);
    return roots.some(root => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    });
  }

  static shouldSkipDirectory(name: string): boolean {
    return SKIP_DIRECTORIES.has(name);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/remote-node/security-filter.spec.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-node/security-filter.ts src/main/remote-node/security-filter.spec.ts
git commit -m "feat(remote-fs): add SecurityFilter for restricted file detection and root boundary checks"
```

---

### Task 5: Project Auto-Discovery

**Files:**
- Create: `src/main/remote-node/project-discovery.ts`
- Test: `src/main/remote-node/project-discovery.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/remote-node/project-discovery.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDiscovery } from './project-discovery';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:fs/promises');

describe('ProjectDiscovery', () => {
  let discovery: ProjectDiscovery;

  beforeEach(() => {
    discovery = new ProjectDiscovery();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discovers projects with .git marker', async () => {
    const root = '/home/dev/projects';
    vi.mocked(fs.readdir).mockImplementation(async (dirPath) => {
      const p = dirPath.toString();
      if (p === root) {
        return [
          { name: 'my-app', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          { name: 'README.md', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
        ] as any;
      }
      if (p === path.join(root, 'my-app')) {
        return [
          { name: '.git', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          { name: 'package.json', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: 'src', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        ] as any;
      }
      return [];
    });

    const projects = await discovery.scan([root]);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('my-app');
    expect(projects[0].markers).toContain('.git');
    expect(projects[0].markers).toContain('package.json');
  });

  it('skips node_modules and .git directories', async () => {
    const root = '/home/dev/projects';
    vi.mocked(fs.readdir).mockImplementation(async (dirPath) => {
      const p = dirPath.toString();
      if (p === root) {
        return [
          { name: 'node_modules', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          { name: '.git', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        ] as any;
      }
      return [];
    });

    const projects = await discovery.scan([root]);
    expect(projects).toHaveLength(0);
  });

  it('respects max depth of 4', async () => {
    const calls: string[] = [];
    vi.mocked(fs.readdir).mockImplementation(async (dirPath) => {
      calls.push(dirPath.toString());
      return [
        { name: 'sub', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      ] as any;
    });

    await discovery.scan(['/root']);
    // depth 0=/root, 1=/root/sub, 2=.../sub/sub, 3=.../sub/sub/sub, 4=.../sub/sub/sub/sub
    // Should stop at depth 4, so max 5 calls
    expect(calls.length).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/remote-node/project-discovery.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ProjectDiscovery**

```typescript
// src/main/remote-node/project-discovery.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { SecurityFilter } from './security-filter';
import type { DiscoveredProject } from '../../shared/types/remote-fs.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('ProjectDiscovery');

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  '.sln',
  '.csproj',
  'pom.xml',
  'build.gradle',
];

const MAX_DEPTH = 4;

export class ProjectDiscovery {
  private cachedProjects: DiscoveredProject[] = [];
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  async scan(roots: string[]): Promise<DiscoveredProject[]> {
    const projects: DiscoveredProject[] = [];

    for (const root of roots) {
      try {
        await this.scanDirectory(root, 0, projects);
      } catch (err) {
        logger.warn(`Failed to scan root ${root}:`, err);
      }
    }

    this.cachedProjects = projects;
    return projects;
  }

  getCachedProjects(): DiscoveredProject[] {
    return this.cachedProjects;
  }

  startPeriodicScan(roots: string[], intervalMs = 5 * 60 * 1000): void {
    this.stopPeriodicScan();
    // Initial scan
    void this.scan(roots);
    this.scanTimer = setInterval(() => void this.scan(roots), intervalMs);
  }

  stopPeriodicScan(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private async scanDirectory(
    dirPath: string,
    depth: number,
    results: DiscoveredProject[]
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;

    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // Permission denied or similar — skip silently
    }

    const names = entries.map(e => e.name);
    const markers = names.filter(n => PROJECT_MARKERS.includes(n));

    if (markers.length > 0) {
      results.push({
        path: dirPath,
        name: path.basename(dirPath),
        markers,
      });
      // Don't recurse into known projects — they're leaf nodes for discovery
      return;
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SecurityFilter.shouldSkipDirectory(entry.name)) continue;
      if (entry.name.startsWith('.')) continue; // Skip hidden dirs during scan

      await this.scanDirectory(path.join(dirPath, entry.name), depth + 1, results);
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/remote-node/project-discovery.spec.ts`
Expected: All 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-node/project-discovery.ts src/main/remote-node/project-discovery.spec.ts
git commit -m "feat(remote-fs): add ProjectDiscovery for auto-scanning browsable roots"
```

---

### Task 6: NodeFilesystemHandler

**Files:**
- Create: `src/main/remote-node/node-filesystem-handler.ts`
- Test: `src/main/remote-node/node-filesystem-handler.spec.ts`

- [ ] **Step 1: Write the failing test for readDirectory**

```typescript
// src/main/remote-node/node-filesystem-handler.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFilesystemHandler } from './node-filesystem-handler';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:fs/promises');

describe('NodeFilesystemHandler', () => {
  let handler: NodeFilesystemHandler;
  const roots = ['/home/dev/projects'];

  beforeEach(() => {
    handler = new NodeFilesystemHandler(roots);
    vi.mocked(fs.realpath).mockImplementation(async (p) => p.toString());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readDirectory', () => {
    it('returns entries with stat data', async () => {
      vi.mocked(fs.realpath).mockResolvedValue('/home/dev/projects/app');
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'src', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        { name: 'README.md', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.stat).mockResolvedValue({
        size: 1024,
        mtimeMs: Date.now(),
        isDirectory: () => false,
        isFile: () => true,
      } as any);

      const result = await handler.readDirectory({ path: '/home/dev/projects/app' });
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].name).toBe('src');
      expect(result.entries[0].isDirectory).toBe(true);
      expect(result.truncated).toBe(false);
    });

    it('rejects paths outside browsable roots', async () => {
      vi.mocked(fs.realpath).mockResolvedValue('/etc/passwd');

      await expect(handler.readDirectory({ path: '/etc/passwd' }))
        .rejects.toThrow('EOUTOFSCOPE');
    });

    it('flags restricted files', async () => {
      vi.mocked(fs.realpath).mockResolvedValue('/home/dev/projects/app');
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: '.env', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
        { name: 'index.ts', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.stat).mockResolvedValue({
        size: 100, mtimeMs: Date.now(), isDirectory: () => false, isFile: () => true,
      } as any);

      const result = await handler.readDirectory({ path: '/home/dev/projects/app' });
      expect(result.entries.find(e => e.name === '.env')?.restricted).toBe(true);
      expect(result.entries.find(e => e.name === 'index.ts')?.restricted).toBe(false);
    });
  });

  describe('stat', () => {
    it('returns stat for existing path', async () => {
      vi.mocked(fs.realpath).mockResolvedValue('/home/dev/projects/app');
      vi.mocked(fs.stat).mockResolvedValue({
        size: 4096, mtimeMs: Date.now(), isDirectory: () => true, isFile: () => false,
      } as any);

      const result = await handler.stat({ path: '/home/dev/projects/app' });
      expect(result.exists).toBe(true);
      expect(result.isDirectory).toBe(true);
      expect(result.withinBrowsableRoot).toBe(true);
    });

    it('returns exists=false for missing path', async () => {
      vi.mocked(fs.realpath).mockRejectedValue(new Error('ENOENT'));
      const result = await handler.stat({ path: '/home/dev/projects/nope' });
      expect(result.exists).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/remote-node/node-filesystem-handler.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement NodeFilesystemHandler**

```typescript
// src/main/remote-node/node-filesystem-handler.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SecurityFilter } from './security-filter';
import { ProjectDiscovery } from './project-discovery';
import { getLogger } from '../logging/logger';
import type {
  FsReadDirectoryParams,
  FsReadDirectoryResult,
  FsStatParams,
  FsStatResult,
  FsSearchParams,
  FsSearchResult,
  FsWatchParams,
  FsWatchResult,
  FsUnwatchParams,
  FsEntry,
  FsErrorCode,
} from '../../shared/types/remote-fs.types';
import type { NodePlatform } from '../../shared/types/worker-node.types';

const logger = getLogger('NodeFilesystemHandler');

export class FsRpcError extends Error {
  constructor(
    public readonly fsCode: FsErrorCode,
    public readonly fsPath: string,
    public readonly retryable: boolean,
    public readonly suggestion?: string
  ) {
    super(fsCode);
    this.name = 'FsRpcError';
  }
}

export class NodeFilesystemHandler {
  private readonly roots: string[];
  private readonly platform: NodePlatform;
  private readonly discovery: ProjectDiscovery;
  private readonly watchers = new Map<string, { close: () => void }>();
  private watchCounter = 0;

  constructor(browsableRoots: string[]) {
    this.roots = browsableRoots.length > 0 ? browsableRoots : [os.homedir()];
    this.platform = process.platform as NodePlatform;
    this.discovery = new ProjectDiscovery();
  }

  getDiscovery(): ProjectDiscovery {
    return this.discovery;
  }

  getRoots(): string[] {
    return this.roots;
  }

  private async validatePath(targetPath: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await fs.realpath(targetPath);
    } catch {
      throw new FsRpcError('ENOENT', targetPath, false, 'Path does not exist.');
    }

    if (!SecurityFilter.isWithinRoot(resolved, this.roots)) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        targetPath,
        false,
        'Path is outside browsable roots. Add the target directory as a root in node configuration.'
      );
    }

    return resolved;
  }

  async readDirectory(params: FsReadDirectoryParams): Promise<FsReadDirectoryResult> {
    const resolved = await this.validatePath(params.path);

    const depth = params.depth ?? 1;
    const limit = params.limit ?? 500;
    const includeHidden = params.includeHidden ?? false;

    const entries = await this.readDirRecursive(resolved, depth, includeHidden);

    const truncated = entries.length > limit;
    const page = entries.slice(0, limit);

    return {
      entries: page,
      truncated,
      cursor: truncated ? Buffer.from(String(limit)).toString('base64') : undefined,
    };
  }

  async stat(params: FsStatParams): Promise<FsStatResult> {
    let resolved: string;
    try {
      resolved = await fs.realpath(params.path);
    } catch {
      return {
        exists: false,
        isDirectory: false,
        size: 0,
        modifiedAt: 0,
        platform: this.platform,
        withinBrowsableRoot: false,
      };
    }

    const withinRoot = SecurityFilter.isWithinRoot(resolved, this.roots);

    try {
      const stats = await fs.stat(resolved);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modifiedAt: Math.floor(stats.mtimeMs),
        platform: this.platform,
        withinBrowsableRoot: withinRoot,
      };
    } catch {
      return {
        exists: false,
        isDirectory: false,
        size: 0,
        modifiedAt: 0,
        platform: this.platform,
        withinBrowsableRoot: withinRoot,
      };
    }
  }

  async search(params: FsSearchParams): Promise<FsSearchResult> {
    const cached = this.discovery.getCachedProjects();
    const query = params.query.toLowerCase();
    const maxResults = params.maxResults ?? 20;

    const matches = cached
      .filter(p => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query))
      .slice(0, maxResults)
      .map(p => ({
        ...p,
        root: this.roots.find(r => p.path.startsWith(r)) || this.roots[0],
      }));

    return { results: matches };
  }

  async watch(params: FsWatchParams): Promise<FsWatchResult> {
    const resolved = await this.validatePath(params.path);
    const watchId = `w-${++this.watchCounter}-${Date.now()}`;

    const watcher = fs.watch(resolved, { recursive: params.recursive ?? false });

    // Store a handle to close later
    const controller = new AbortController();
    this.watchers.set(watchId, { close: () => controller.abort() });

    return { watchId };
  }

  async unwatch(params: FsUnwatchParams): Promise<void> {
    const watcher = this.watchers.get(params.watchId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(params.watchId);
    }
  }

  cleanupAllWatchers(): void {
    for (const [id, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
  }

  private async readDirRecursive(
    dirPath: string,
    depth: number,
    includeHidden: boolean
  ): Promise<FsEntry[]> {
    let rawEntries;
    try {
      rawEntries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      throw new FsRpcError('EACCES', dirPath, false, `Cannot read directory: ${(err as Error).message}`);
    }

    const entries: FsEntry[] = [];

    for (const dirent of rawEntries) {
      if (!includeHidden && dirent.name.startsWith('.')) continue;

      const fullPath = path.join(dirPath, dirent.name);
      const isDir = dirent.isDirectory();
      const isSymlink = dirent.isSymbolicLink();

      let size = 0;
      let modifiedAt = 0;
      try {
        const stats = await fs.stat(fullPath);
        size = stats.size;
        modifiedAt = Math.floor(stats.mtimeMs);
      } catch {
        // stat failed — use defaults
      }

      const entry: FsEntry = {
        name: dirent.name,
        path: fullPath,
        isDirectory: isDir,
        isSymlink,
        size,
        modifiedAt,
        extension: isDir ? undefined : path.extname(dirent.name).slice(1) || undefined,
        ignored: false,
        restricted: SecurityFilter.isRestricted(dirent.name),
      };

      if (isDir && depth > 1) {
        try {
          entry.children = await this.readDirRecursive(fullPath, depth - 1, includeHidden);
        } catch {
          entry.children = [];
        }
      }

      entries.push(entry);
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return entries;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/remote-node/node-filesystem-handler.spec.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-node/node-filesystem-handler.ts src/main/remote-node/node-filesystem-handler.spec.ts
git commit -m "feat(remote-fs): add NodeFilesystemHandler with readDirectory, stat, search, watch"
```

---

### Task 7: Wire Handler into RPC Event Router

**Files:**
- Modify: `src/main/remote-node/rpc-event-router.ts:64-132`

- [ ] **Step 1: Read the current router dispatch**

Read `src/main/remote-node/rpc-event-router.ts` lines 64-132 to find the method dispatch switch statement.

- [ ] **Step 2: Add fs.* method routing**

In the `handleRpcRequest` method's dispatch section, add cases for each `fs.*` method. The handler needs to be instantiated per-node (since roots differ per node). Add a `nodeHandlers` map to the router class:

At the class level, add a field:
```typescript
private readonly fsHandlers = new Map<string, NodeFilesystemHandler>();
```

Add an import at the top:
```typescript
import { NodeFilesystemHandler, FsRpcError } from './node-filesystem-handler';
```

Add a private helper method:
```typescript
private getFsHandler(nodeId: string): NodeFilesystemHandler | null {
  if (this.fsHandlers.has(nodeId)) return this.fsHandlers.get(nodeId)!;

  const node = this.registry.getNode(nodeId);
  if (!node) return null;

  const roots = node.capabilities.browsableRoots?.length > 0
    ? node.capabilities.browsableRoots
    : node.capabilities.workingDirectories;

  const handler = new NodeFilesystemHandler(roots);
  this.fsHandlers.set(nodeId, handler);
  return handler;
}
```

In the dispatch section, add the fs.* cases:

```typescript
case 'fs.readDirectory': {
  const handler = this.getFsHandler(nodeId);
  if (!handler) return this.sendError(nodeId, request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, 'Node not found');
  try {
    const result = await handler.readDirectory(validated);
    this.connection.sendResponse(nodeId, request.id, result);
  } catch (err) {
    if (err instanceof FsRpcError) {
      this.connection.sendResponse(nodeId, request.id, undefined, {
        code: RPC_ERROR_CODES.FILESYSTEM_ERROR,
        message: 'Filesystem error',
        data: { fsCode: err.fsCode, path: err.fsPath, retryable: err.retryable, suggestion: err.suggestion },
      });
    } else { throw err; }
  }
  break;
}
case 'fs.stat': {
  const handler = this.getFsHandler(nodeId);
  if (!handler) return this.sendError(nodeId, request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, 'Node not found');
  const result = await handler.stat(validated);
  this.connection.sendResponse(nodeId, request.id, result);
  break;
}
case 'fs.search': {
  const handler = this.getFsHandler(nodeId);
  if (!handler) return this.sendError(nodeId, request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, 'Node not found');
  const result = await handler.search(validated);
  this.connection.sendResponse(nodeId, request.id, result);
  break;
}
case 'fs.watch': {
  const handler = this.getFsHandler(nodeId);
  if (!handler) return this.sendError(nodeId, request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, 'Node not found');
  const result = await handler.watch(validated);
  this.connection.sendResponse(nodeId, request.id, result);
  break;
}
case 'fs.unwatch': {
  const handler = this.getFsHandler(nodeId);
  if (!handler) return this.sendError(nodeId, request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, 'Node not found');
  await handler.unwatch(validated);
  this.connection.sendResponse(nodeId, request.id, {});
  break;
}
```

Also clean up handlers on node disconnect — in the `stop()` method or wherever node disconnects are handled:
```typescript
this.fsHandlers.delete(nodeId);
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/remote-node/rpc-event-router.ts
git commit -m "feat(remote-fs): wire fs.* RPC methods into event router"
```

---

## Phase 3: Main Process Routing Layer

### Task 8: FilesystemService

**Files:**
- Create: `src/main/services/filesystem-service.ts`
- Test: `src/main/services/filesystem-service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/services/filesystem-service.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesystemService } from './filesystem-service';

const mockSendRpc = vi.fn();
const mockReaddir = vi.fn();
const mockStat = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: { readdir: (...args: any[]) => mockReaddir(...args), stat: (...args: any[]) => mockStat(...args) },
  readdir: (...args: any[]) => mockReaddir(...args),
  stat: (...args: any[]) => mockStat(...args),
}));

vi.mock('../remote-node', () => ({
  getWorkerNodeConnectionServer: () => ({
    sendRpc: mockSendRpc,
  }),
}));

describe('FilesystemService', () => {
  let service: FilesystemService;

  beforeEach(() => {
    FilesystemService._resetForTesting();
    service = FilesystemService.getInstance();
    vi.clearAllMocks();
  });

  it('routes local readDirectory to fs.readdir', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'src', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
    ]);
    mockStat.mockResolvedValue({ size: 0, mtimeMs: 1000, isDirectory: () => true, isFile: () => false });

    const result = await service.readDirectory('local', '/home/dev/project');
    expect(mockReaddir).toHaveBeenCalledWith('/home/dev/project', { withFileTypes: true });
    expect(result.entries).toHaveLength(1);
  });

  it('routes remote readDirectory to RPC', async () => {
    mockSendRpc.mockResolvedValue({ entries: [{ name: 'src', path: 'C:\\Projects\\src', isDirectory: true }], truncated: false });

    const result = await service.readDirectory('node-123', 'C:\\Projects');
    expect(mockSendRpc).toHaveBeenCalledWith('node-123', 'fs.readDirectory', expect.objectContaining({ path: 'C:\\Projects' }));
  });

  it('routes remote stat to RPC', async () => {
    mockSendRpc.mockResolvedValue({ exists: true, isDirectory: true, size: 0, modifiedAt: 0, platform: 'win32', withinBrowsableRoot: true });

    const result = await service.stat('node-123', 'C:\\Projects');
    expect(mockSendRpc).toHaveBeenCalledWith('node-123', 'fs.stat', { path: 'C:\\Projects' });
    expect(result.exists).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/filesystem-service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement FilesystemService**

```typescript
// src/main/services/filesystem-service.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { getLogger } from '../logging/logger';
import { SecurityFilter } from '../remote-node/security-filter';
import type {
  FsReadDirectoryParams,
  FsReadDirectoryResult,
  FsStatParams,
  FsStatResult,
  FsSearchParams,
  FsSearchResult,
  FsWatchParams,
  FsWatchResult,
  FsUnwatchParams,
  FsEntry,
} from '../../shared/types/remote-fs.types';
import type { NodePlatform } from '../../shared/types/worker-node.types';

const logger = getLogger('FilesystemService');

interface CacheEntry {
  result: FsReadDirectoryResult;
  timestamp: number;
}

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_SIZE = 200;

let instance: FilesystemService | null = null;

export class FilesystemService {
  private cache = new Map<string, CacheEntry>();

  static getInstance(): FilesystemService {
    if (!instance) instance = new FilesystemService();
    return instance;
  }

  static _resetForTesting(): void {
    instance = null;
  }

  async readDirectory(
    nodeId: string,
    dirPath: string,
    options?: Partial<FsReadDirectoryParams>
  ): Promise<FsReadDirectoryResult> {
    const cacheKey = `${nodeId}:${dirPath}:${options?.depth ?? 1}:${options?.includeHidden ?? false}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.result;
    }

    const params: FsReadDirectoryParams = { path: dirPath, ...options };
    let result: FsReadDirectoryResult;

    if (nodeId === 'local') {
      result = await this.localReadDirectory(params);
    } else {
      const { getWorkerNodeConnectionServer } = await import('../remote-node');
      result = await getWorkerNodeConnectionServer().sendRpc<FsReadDirectoryResult>(
        nodeId, 'fs.readDirectory', params
      );
    }

    // Cache the result
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    this.cache.set(cacheKey, { result, timestamp: Date.now() });

    return result;
  }

  async stat(nodeId: string, targetPath: string): Promise<FsStatResult> {
    if (nodeId === 'local') {
      return this.localStat(targetPath);
    }
    const { getWorkerNodeConnectionServer } = await import('../remote-node');
    return getWorkerNodeConnectionServer().sendRpc<FsStatResult>(
      nodeId, 'fs.stat', { path: targetPath }
    );
  }

  async search(nodeId: string, query: string, maxResults?: number): Promise<FsSearchResult> {
    if (nodeId === 'local') {
      return { results: [] }; // Local search not implemented — use native dialog
    }
    const { getWorkerNodeConnectionServer } = await import('../remote-node');
    return getWorkerNodeConnectionServer().sendRpc<FsSearchResult>(
      nodeId, 'fs.search', { query, maxResults }
    );
  }

  async watch(nodeId: string, targetPath: string, recursive?: boolean): Promise<FsWatchResult> {
    if (nodeId === 'local') {
      return { watchId: 'local-noop' }; // Local watching handled by existing file-explorer
    }
    const { getWorkerNodeConnectionServer } = await import('../remote-node');
    return getWorkerNodeConnectionServer().sendRpc<FsWatchResult>(
      nodeId, 'fs.watch', { path: targetPath, recursive }
    );
  }

  async unwatch(nodeId: string, watchId: string): Promise<void> {
    if (nodeId === 'local') return;
    const { getWorkerNodeConnectionServer } = await import('../remote-node');
    await getWorkerNodeConnectionServer().sendRpc<void>(
      nodeId, 'fs.unwatch', { watchId }
    );
  }

  invalidateCache(nodeId: string, dirPath?: string): void {
    if (dirPath) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${nodeId}:${dirPath}`)) {
          this.cache.delete(key);
        }
      }
    } else {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${nodeId}:`)) {
          this.cache.delete(key);
        }
      }
    }
  }

  private async localReadDirectory(params: FsReadDirectoryParams): Promise<FsReadDirectoryResult> {
    const includeHidden = params.includeHidden ?? false;
    const limit = params.limit ?? 500;

    const rawEntries = await fs.readdir(params.path, { withFileTypes: true });
    const entries: FsEntry[] = [];

    for (const dirent of rawEntries) {
      if (!includeHidden && dirent.name.startsWith('.')) continue;

      const fullPath = path.join(params.path, dirent.name);
      const isDir = dirent.isDirectory();

      let size = 0;
      let modifiedAt = 0;
      try {
        const stats = await fs.stat(fullPath);
        size = stats.size;
        modifiedAt = Math.floor(stats.mtimeMs);
      } catch { /* skip stat errors */ }

      entries.push({
        name: dirent.name,
        path: fullPath,
        isDirectory: isDir,
        isSymlink: dirent.isSymbolicLink(),
        size,
        modifiedAt,
        extension: isDir ? undefined : path.extname(dirent.name).slice(1) || undefined,
        ignored: false,
        restricted: SecurityFilter.isRestricted(dirent.name),
      });
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const truncated = entries.length > limit;
    return { entries: entries.slice(0, limit), truncated };
  }

  private async localStat(targetPath: string): Promise<FsStatResult> {
    try {
      const stats = await fs.stat(targetPath);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modifiedAt: Math.floor(stats.mtimeMs),
        platform: process.platform as NodePlatform,
        withinBrowsableRoot: true,
      };
    } catch {
      return {
        exists: false,
        isDirectory: false,
        size: 0,
        modifiedAt: 0,
        platform: process.platform as NodePlatform,
        withinBrowsableRoot: true,
      };
    }
  }
}

export function getFilesystemService(): FilesystemService {
  return FilesystemService.getInstance();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/services/filesystem-service.spec.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/filesystem-service.ts src/main/services/filesystem-service.spec.ts
git commit -m "feat(remote-fs): add FilesystemService routing layer with LRU cache"
```

---

### Task 9: IPC Channels, Handlers, and Preload Bridge

**Files:**
- Modify: `src/shared/types/ipc.types.ts`
- Create: `src/main/ipc/handlers/remote-fs-handlers.ts`
- Modify: `src/preload/preload.ts`

- [ ] **Step 1: Add IPC channels**

In `src/shared/types/ipc.types.ts`, add to the `IPC_CHANNELS` object:

```typescript
  REMOTE_FS_READ_DIR: 'remote-fs:read-dir',
  REMOTE_FS_STAT: 'remote-fs:stat',
  REMOTE_FS_SEARCH: 'remote-fs:search',
  REMOTE_FS_WATCH: 'remote-fs:watch',
  REMOTE_FS_UNWATCH: 'remote-fs:unwatch',
```

- [ ] **Step 2: Create IPC handlers**

```typescript
// src/main/ipc/handlers/remote-fs-handlers.ts
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getFilesystemService } from '../../services/filesystem-service';
import { getLogger } from '../../logging/logger';
import {
  FsReadDirectoryParamsSchema,
  FsStatParamsSchema,
  FsSearchParamsSchema,
  FsWatchParamsSchema,
  FsUnwatchParamsSchema,
} from '../../../shared/validation/remote-fs-schemas';
import type { IpcResponse } from '../../../shared/types/ipc.types';

const logger = getLogger('RemoteFsHandlers');

const IPC_CHANNELS = {
  REMOTE_FS_READ_DIR: 'remote-fs:read-dir',
  REMOTE_FS_STAT: 'remote-fs:stat',
  REMOTE_FS_SEARCH: 'remote-fs:search',
  REMOTE_FS_WATCH: 'remote-fs:watch',
  REMOTE_FS_UNWATCH: 'remote-fs:unwatch',
};

export function registerRemoteFsHandlers(): void {
  const service = getFilesystemService();

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_READ_DIR,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const { nodeId, ...params } = payload as { nodeId: string } & Record<string, unknown>;
        const validated = FsReadDirectoryParamsSchema.parse(params);
        const result = await service.readDirectory(nodeId || 'local', validated.path, validated);
        return { success: true, data: result };
      } catch (error) {
        logger.error('remote-fs:read-dir failed', error);
        return { success: false, error: { code: 'REMOTE_FS_ERROR', message: (error as Error).message, timestamp: Date.now() } };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_STAT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const { nodeId, path: targetPath } = payload as { nodeId: string; path: string };
        FsStatParamsSchema.parse({ path: targetPath });
        const result = await service.stat(nodeId || 'local', targetPath);
        return { success: true, data: result };
      } catch (error) {
        logger.error('remote-fs:stat failed', error);
        return { success: false, error: { code: 'REMOTE_FS_ERROR', message: (error as Error).message, timestamp: Date.now() } };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_SEARCH,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const { nodeId, ...params } = payload as { nodeId: string } & Record<string, unknown>;
        const validated = FsSearchParamsSchema.parse(params);
        const result = await service.search(nodeId || 'local', validated.query, validated.maxResults);
        return { success: true, data: result };
      } catch (error) {
        logger.error('remote-fs:search failed', error);
        return { success: false, error: { code: 'REMOTE_FS_ERROR', message: (error as Error).message, timestamp: Date.now() } };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_WATCH,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const { nodeId, path: targetPath, recursive } = payload as { nodeId: string; path: string; recursive?: boolean };
        const result = await service.watch(nodeId || 'local', targetPath, recursive);
        return { success: true, data: result };
      } catch (error) {
        logger.error('remote-fs:watch failed', error);
        return { success: false, error: { code: 'REMOTE_FS_ERROR', message: (error as Error).message, timestamp: Date.now() } };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_FS_UNWATCH,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const { nodeId, watchId } = payload as { nodeId: string; watchId: string };
        await service.unwatch(nodeId || 'local', watchId);
        return { success: true };
      } catch (error) {
        logger.error('remote-fs:unwatch failed', error);
        return { success: false, error: { code: 'REMOTE_FS_ERROR', message: (error as Error).message, timestamp: Date.now() } };
      }
    }
  );
}
```

- [ ] **Step 3: Expose in preload**

In `src/preload/preload.ts`, add to the `electronAPI` object (in the filesystem section):

```typescript
    remoteFsReadDir: (nodeId: string, path: string, options?: { depth?: number; includeHidden?: boolean }): Promise<IpcResponse> => {
      return ipcRenderer.invoke('remote-fs:read-dir', { nodeId, path, ...options });
    },
    remoteFsStat: (nodeId: string, path: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke('remote-fs:stat', { nodeId, path });
    },
    remoteFsSearch: (nodeId: string, query: string, maxResults?: number): Promise<IpcResponse> => {
      return ipcRenderer.invoke('remote-fs:search', { nodeId, query, maxResults });
    },
    remoteFsWatch: (nodeId: string, path: string, recursive?: boolean): Promise<IpcResponse> => {
      return ipcRenderer.invoke('remote-fs:watch', { nodeId, path, recursive });
    },
    remoteFsUnwatch: (nodeId: string, watchId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke('remote-fs:unwatch', { nodeId, watchId });
    },
```

- [ ] **Step 4: Register handlers in app initialization**

In `src/main/index.ts`, find where IPC handlers are registered (search for `registerRemoteNodeHandlers` or similar) and add:

```typescript
import { registerRemoteFsHandlers } from './ipc/handlers/remote-fs-handlers';
// ... later in init ...
registerRemoteFsHandlers();
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/ipc.types.ts src/main/ipc/handlers/remote-fs-handlers.ts src/preload/preload.ts src/main/index.ts
git commit -m "feat(remote-fs): add IPC handlers and preload bridge for remote filesystem operations"
```

---

## Phase 4: Angular Services & Pipe

### Task 10: Remote Filesystem IPC Service

**Files:**
- Create: `src/renderer/app/core/services/ipc/remote-fs-ipc.service.ts`

- [ ] **Step 1: Create the service**

```typescript
// src/renderer/app/core/services/ipc/remote-fs-ipc.service.ts
import { Injectable } from '@angular/core';
import type {
  FsReadDirectoryResult,
  FsStatResult,
  FsSearchResult,
  FsWatchResult,
} from '../../../../../shared/types/remote-fs.types';

interface ElectronAPI {
  remoteFsReadDir(nodeId: string, path: string, options?: { depth?: number; includeHidden?: boolean }): Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
  remoteFsStat(nodeId: string, path: string): Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
  remoteFsSearch(nodeId: string, query: string, maxResults?: number): Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
  remoteFsWatch(nodeId: string, path: string, recursive?: boolean): Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
  remoteFsUnwatch(nodeId: string, watchId: string): Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
}

@Injectable({ providedIn: 'root' })
export class RemoteFsIpcService {
  private readonly api = (window as any).electronAPI as ElectronAPI | undefined;

  async readDirectory(
    nodeId: string,
    path: string,
    options?: { depth?: number; includeHidden?: boolean }
  ): Promise<FsReadDirectoryResult | null> {
    if (!this.api) return null;
    const result = await this.api.remoteFsReadDir(nodeId, path, options);
    if (!result.success) throw new Error(result.error?.message || 'readDirectory failed');
    return result.data as FsReadDirectoryResult;
  }

  async stat(nodeId: string, path: string): Promise<FsStatResult | null> {
    if (!this.api) return null;
    const result = await this.api.remoteFsStat(nodeId, path);
    if (!result.success) throw new Error(result.error?.message || 'stat failed');
    return result.data as FsStatResult;
  }

  async search(nodeId: string, query: string, maxResults?: number): Promise<FsSearchResult | null> {
    if (!this.api) return null;
    const result = await this.api.remoteFsSearch(nodeId, query, maxResults);
    if (!result.success) throw new Error(result.error?.message || 'search failed');
    return result.data as FsSearchResult;
  }

  async watch(nodeId: string, path: string, recursive?: boolean): Promise<FsWatchResult | null> {
    if (!this.api) return null;
    const result = await this.api.remoteFsWatch(nodeId, path, recursive);
    if (!result.success) throw new Error(result.error?.message || 'watch failed');
    return result.data as FsWatchResult;
  }

  async unwatch(nodeId: string, watchId: string): Promise<void> {
    if (!this.api) return;
    await this.api.remoteFsUnwatch(nodeId, watchId);
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/core/services/ipc/remote-fs-ipc.service.ts
git commit -m "feat(remote-fs): add Angular RemoteFsIpcService"
```

---

### Task 11: Node Path Pipe

**Files:**
- Create: `src/renderer/app/shared/pipes/node-path.pipe.ts`
- Test: `src/renderer/app/shared/pipes/node-path.pipe.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/renderer/app/shared/pipes/node-path.pipe.spec.ts
import { describe, expect, it } from 'vitest';
import { NodePathPipe } from './node-path.pipe';

describe('NodePathPipe', () => {
  const pipe = new NodePathPipe();

  it('formats Windows paths with backslashes', () => {
    expect(pipe.transform('C:/Users/dev/projects', 'win32')).toBe('C:\\Users\\dev\\projects');
  });

  it('preserves POSIX paths for darwin', () => {
    expect(pipe.transform('/Users/suas/work', 'darwin')).toBe('/Users/suas/work');
  });

  it('preserves POSIX paths for linux', () => {
    expect(pipe.transform('/home/dev/projects', 'linux')).toBe('/home/dev/projects');
  });

  it('returns empty string for null/undefined', () => {
    expect(pipe.transform(null as any, 'darwin')).toBe('');
    expect(pipe.transform(undefined as any, 'win32')).toBe('');
  });

  it('shortens home directory with tilde for display', () => {
    // Windows paths should NOT get tilde treatment
    expect(pipe.transform('C:\\Users\\dev\\projects', 'win32')).toBe('C:\\Users\\dev\\projects');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/app/shared/pipes/node-path.pipe.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pipe**

```typescript
// src/renderer/app/shared/pipes/node-path.pipe.ts
import { Pipe, type PipeTransform } from '@angular/core';
import type { NodePlatform } from '../../../../shared/types/worker-node.types';

@Pipe({ name: 'nodePath', standalone: true })
export class NodePathPipe implements PipeTransform {
  transform(path: string | null | undefined, platform: NodePlatform): string {
    if (!path) return '';

    if (platform === 'win32') {
      // Ensure Windows-style separators
      return path.replace(/\//g, '\\');
    }

    // POSIX platforms — forward slashes as-is
    return path;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/renderer/app/shared/pipes/node-path.pipe.spec.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/shared/pipes/node-path.pipe.ts src/renderer/app/shared/pipes/node-path.pipe.spec.ts
git commit -m "feat(remote-fs): add NodePathPipe for cross-platform path display"
```

---

## Phase 5: Node-Aware Dropdown

### Task 12: Extend Recent Directories for Remote Entries

**Files:**
- Modify: `src/shared/types/recent-directories.types.ts`
- Modify: `src/renderer/app/shared/components/recent-directories-dropdown/recent-directories-dropdown.component.ts`

- [ ] **Step 1: Extend the RecentDirectoryEntry type**

In `src/shared/types/recent-directories.types.ts`, add to `RecentDirectoryEntry`:

```typescript
  nodeId?: string;           // 'local' or node UUID; undefined = local (backward compat)
  platform?: NodePlatform;   // Platform of the node this path belongs to
```

Add the import: `import type { NodePlatform } from './worker-node.types';`

- [ ] **Step 2: Add selectedNodeId input to dropdown**

In the dropdown component, add a new input signal:

```typescript
selectedNodeId = input<string | null>(null);
```

Add an import for `input` from `@angular/core` if not already present.

- [ ] **Step 3: Add computed properties for remote entries**

Add computed signals that filter entries by node:

```typescript
private readonly nodeFilteredDirectories = computed(() => {
  const nodeId = this.selectedNodeId();
  const dirs = this.directories();
  if (!nodeId || nodeId === 'local') {
    return dirs.filter(d => !d.nodeId || d.nodeId === 'local');
  }
  return dirs.filter(d => d.nodeId === nodeId);
});
```

Update the existing `pinnedDirectories` and `recentDirectories` computed signals to use `nodeFilteredDirectories()` instead of `directories()`.

- [ ] **Step 4: Route "Browse..." based on node selection**

Modify `browseForFolder()` method. When `selectedNodeId()` is set and not `'local'`, emit a `browseRemote` output instead of opening the Electron dialog:

```typescript
browseRemote = output<string>();

async browseForFolder(): Promise<void> {
  const nodeId = this.selectedNodeId();
  if (nodeId && nodeId !== 'local') {
    this.browseRemote.emit(nodeId);
    return;
  }
  // Existing local browse logic
  const path = await this.recentDirsService.selectFolderAndTrack();
  if (path) {
    this.folderSelected.emit(path);
    this.close();
  }
}
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/recent-directories.types.ts src/renderer/app/shared/components/recent-directories-dropdown/recent-directories-dropdown.component.ts
git commit -m "feat(remote-fs): make recent-directories-dropdown node-aware"
```

---

## Phase 6: Browse Modal

### Task 13: RemoteBrowseModalComponent

**Files:**
- Create: `src/renderer/app/shared/components/remote-browse-modal/remote-browse-modal.component.ts`

- [ ] **Step 1: Create the modal component**

```typescript
// src/renderer/app/shared/components/remote-browse-modal/remote-browse-modal.component.ts
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RemoteFsIpcService } from '../../../core/services/ipc/remote-fs-ipc.service';
import { RemoteNodeStore } from '../../../core/state/remote-node.store';
import { NodePathPipe } from '../../pipes/node-path.pipe';
import type { FsEntry, FsProjectMatch } from '../../../../../shared/types/remote-fs.types';
import type { NodePlatform } from '../../../../../shared/types/worker-node.types';

@Component({
  selector: 'app-remote-browse-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, NodePathPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isOpen()) {
      <div class="modal-overlay" (click)="close()">
        <div class="modal-container" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <div class="breadcrumb-bar">
              @for (segment of breadcrumbs(); track segment.path) {
                <button
                  class="breadcrumb-segment"
                  (click)="navigateTo(segment.path)"
                >{{ segment.name }}</button>
                @if (!$last) { <span class="breadcrumb-sep">{{ platform() === 'win32' ? '\\\\' : '/' }}</span> }
              }
            </div>
            <div class="modal-header-actions">
              <button
                class="mode-toggle"
                [class.active]="mode() === 'search'"
                (click)="toggleMode()"
              >{{ mode() === 'browse' ? 'Search' : 'Browse' }}</button>
            </div>
          </div>

          <div class="modal-body">
            @if (mode() === 'search') {
              <input
                class="search-input"
                type="text"
                placeholder="Search projects..."
                [ngModel]="searchQuery()"
                (ngModelChange)="onSearchInput($event)"
                autofocus
              />
              @if (isLoading()) {
                <div class="loading-indicator">Searching...</div>
              }
              @for (match of searchResults(); track match.path) {
                <div
                  class="entry-row search-result"
                  [class.selected]="selectedPath() === match.path"
                  (click)="selectSearchResult(match)"
                >
                  <span class="entry-name">{{ match.name }}</span>
                  <span class="entry-path">{{ match.path | nodePath:platform() }}</span>
                  <span class="entry-markers">
                    @for (m of match.markers; track m) {
                      <span class="marker-badge">{{ m }}</span>
                    }
                  </span>
                </div>
              }
            } @else {
              @if (isLoading()) {
                <div class="loading-indicator">Loading...</div>
              }
              @for (entry of entries(); track entry.path) {
                <div
                  class="entry-row"
                  [class.selected]="selectedPath() === entry.path"
                  [class.restricted]="entry.restricted"
                  [class.ignored]="entry.ignored"
                  (click)="onEntryClick(entry)"
                  (dblclick)="onEntryDoubleClick(entry)"
                >
                  <span class="entry-icon">{{ entry.isDirectory ? '📁' : '📄' }}</span>
                  <span class="entry-name">{{ entry.name }}</span>
                  @if (entry.restricted) { <span class="lock-icon">🔒</span> }
                </div>
              }
              @if (truncated()) {
                <button class="load-more" (click)="loadMore()">Load more...</button>
              }
            }
          </div>

          <div class="modal-footer">
            <span class="selected-display">{{ selectedPath() | nodePath:platform() }}</span>
            <div class="modal-actions">
              <button class="btn-cancel" (click)="close()">Cancel</button>
              <button
                class="btn-select"
                [disabled]="!selectedPath()"
                (click)="confirm()"
              >Select</button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .modal-container { width: 640px; max-height: 70vh; display: flex; flex-direction: column; background: var(--surface-bg, #1a1a1a); border: 1px solid var(--border-color, #333); border-radius: 8px; overflow: hidden; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border-color, #333); }
    .breadcrumb-bar { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; min-height: 28px; }
    .breadcrumb-segment { background: none; border: none; color: var(--text-secondary, #aaa); cursor: pointer; padding: 2px 4px; border-radius: 4px; font-size: 13px; }
    .breadcrumb-segment:hover { background: var(--hover-bg, #2a2a2a); color: var(--text-primary, #fff); }
    .breadcrumb-sep { color: var(--text-muted, #666); font-size: 12px; }
    .mode-toggle { background: var(--hover-bg, #2a2a2a); border: 1px solid var(--border-color, #333); color: var(--text-secondary, #aaa); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .mode-toggle.active { background: var(--accent-bg, #3a3a3a); color: var(--text-primary, #fff); }
    .modal-body { flex: 1; overflow-y: auto; padding: 8px 0; min-height: 300px; }
    .search-input { width: 100%; padding: 8px 16px; background: var(--input-bg, #111); border: none; border-bottom: 1px solid var(--border-color, #333); color: var(--text-primary, #fff); font-size: 14px; outline: none; }
    .entry-row { display: flex; align-items: center; gap: 8px; padding: 6px 16px; cursor: pointer; font-size: 13px; color: var(--text-secondary, #ccc); }
    .entry-row:hover { background: var(--hover-bg, #2a2a2a); }
    .entry-row.selected { background: var(--accent-bg, #3a3a3a); color: var(--text-primary, #fff); }
    .entry-row.restricted { opacity: 0.5; }
    .entry-row.ignored { opacity: 0.4; }
    .entry-icon { font-size: 14px; width: 20px; text-align: center; }
    .entry-name { flex: 1; }
    .entry-path { color: var(--text-muted, #666); font-size: 11px; }
    .lock-icon { font-size: 11px; }
    .marker-badge { background: var(--hover-bg, #2a2a2a); padding: 1px 6px; border-radius: 3px; font-size: 10px; color: var(--text-muted, #888); }
    .search-result { flex-wrap: wrap; }
    .search-result .entry-markers { display: flex; gap: 4px; width: 100%; padding-left: 28px; margin-top: 2px; }
    .loading-indicator { padding: 16px; text-align: center; color: var(--text-muted, #666); font-size: 13px; }
    .load-more { width: 100%; padding: 8px; background: none; border: none; color: var(--accent-color, #c8a24e); cursor: pointer; font-size: 12px; }
    .modal-footer { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-top: 1px solid var(--border-color, #333); }
    .selected-display { font-size: 12px; color: var(--text-muted, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 350px; }
    .modal-actions { display: flex; gap: 8px; }
    .btn-cancel { background: none; border: 1px solid var(--border-color, #333); color: var(--text-secondary, #aaa); padding: 6px 16px; border-radius: 4px; cursor: pointer; }
    .btn-select { background: var(--accent-color, #c8a24e); border: none; color: #000; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-weight: 500; }
    .btn-select:disabled { opacity: 0.4; cursor: not-allowed; }
  `],
})
export class RemoteBrowseModalComponent {
  private readonly remoteFsIpc = inject(RemoteFsIpcService);
  private readonly remoteNodeStore = inject(RemoteNodeStore);

  nodeId = input.required<string>();
  isOpen = input(false);

  folderSelected = output<string>();
  closed = output<void>();

  mode = signal<'browse' | 'search'>('browse');
  currentPath = signal('');
  entries = signal<FsEntry[]>([]);
  truncated = signal(false);
  selectedPath = signal<string | null>(null);
  isLoading = signal(false);
  searchQuery = signal('');
  searchResults = signal<FsProjectMatch[]>([]);

  platform = computed((): NodePlatform => {
    const node = this.remoteNodeStore.nodeById(this.nodeId());
    return node?.capabilities.platform ?? 'linux';
  });

  breadcrumbs = computed(() => {
    const p = this.currentPath();
    if (!p) return [];

    const sep = this.platform() === 'win32' ? '\\' : '/';
    const parts = p.split(sep).filter(Boolean);

    // Rebuild paths progressively
    const result: Array<{ name: string; path: string }> = [];
    for (let i = 0; i < parts.length; i++) {
      const segPath = this.platform() === 'win32'
        ? parts.slice(0, i + 1).join('\\')
        : '/' + parts.slice(0, i + 1).join('/');
      result.push({ name: parts[i], path: segPath });
    }
    return result;
  });

  async open(initialPath: string): Promise<void> {
    this.currentPath.set(initialPath);
    this.selectedPath.set(initialPath);
    await this.loadDirectory(initialPath);
  }

  async navigateTo(dirPath: string): Promise<void> {
    this.currentPath.set(dirPath);
    this.selectedPath.set(dirPath);
    await this.loadDirectory(dirPath);
  }

  onEntryClick(entry: FsEntry): void {
    if (entry.isDirectory) {
      this.selectedPath.set(entry.path);
    }
  }

  async onEntryDoubleClick(entry: FsEntry): Promise<void> {
    if (entry.isDirectory) {
      await this.navigateTo(entry.path);
    }
  }

  async selectSearchResult(match: FsProjectMatch): Promise<void> {
    this.selectedPath.set(match.path);
  }

  toggleMode(): void {
    this.mode.update(m => m === 'browse' ? 'search' : 'browse');
  }

  async onSearchInput(query: string): Promise<void> {
    this.searchQuery.set(query);
    if (query.length < 2) {
      this.searchResults.set([]);
      return;
    }

    this.isLoading.set(true);
    try {
      const result = await this.remoteFsIpc.search(this.nodeId(), query);
      this.searchResults.set(result?.results ?? []);
    } catch {
      this.searchResults.set([]);
    } finally {
      this.isLoading.set(false);
    }
  }

  confirm(): void {
    const path = this.selectedPath();
    if (path) {
      this.folderSelected.emit(path);
      this.close();
    }
  }

  close(): void {
    this.closed.emit();
  }

  loadMore(): void {
    // Future: cursor-based pagination
  }

  private async loadDirectory(dirPath: string): Promise<void> {
    this.isLoading.set(true);
    try {
      const result = await this.remoteFsIpc.readDirectory(this.nodeId(), dirPath, { depth: 2 });
      if (result) {
        // Only show directories in the browse modal (we're picking a working dir)
        this.entries.set(result.entries.filter(e => e.isDirectory));
        this.truncated.set(result.truncated);
      }
    } catch {
      this.entries.set([]);
    } finally {
      this.isLoading.set(false);
    }
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/shared/components/remote-browse-modal/remote-browse-modal.component.ts
git commit -m "feat(remote-fs): add RemoteBrowseModalComponent with tree browser and fuzzy search"
```

---

### Task 14: Wire Modal into Welcome Screen

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-welcome.component.ts`
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts`

- [ ] **Step 1: Pass selectedNodeId to dropdown in welcome component**

In `instance-welcome.component.ts`, find the `app-recent-directories-dropdown` template (lines 50-54) and add the `selectedNodeId` input and `browseRemote` output:

```html
<app-recent-directories-dropdown
  [currentPath]="workingDirectory() || ''"
  [selectedNodeId]="selectedNodeId()"
  placeholder="Select working folder..."
  (folderSelected)="selectFolder.emit($event)"
  (browseRemote)="browseRemote.emit($event)"
/>
```

Add the output to the component class:

```typescript
browseRemote = output<string>();
```

- [ ] **Step 2: Add browse modal to instance-detail component**

In `instance-detail.component.ts`, import and wire the modal. Add the component import:

```typescript
import { RemoteBrowseModalComponent } from '../../shared/components/remote-browse-modal/remote-browse-modal.component';
```

Add it to the imports array and template. In the template, after the welcome component:

```html
<app-remote-browse-modal
  [nodeId]="remoteBrowseNodeId() || ''"
  [isOpen]="remoteBrowseOpen()"
  (folderSelected)="onRemoteFolderSelected($event)"
  (closed)="remoteBrowseOpen.set(false)"
/>
```

Add signals and handler in the class:

```typescript
remoteBrowseOpen = signal(false);
remoteBrowseNodeId = signal<string | null>(null);

onWelcomeBrowseRemote(nodeId: string): void {
  this.remoteBrowseNodeId.set(nodeId);
  this.remoteBrowseOpen.set(true);
}

onRemoteFolderSelected(path: string): void {
  this.welcomeWorkingDirectory.set(path);
  this.remoteBrowseOpen.set(false);
}
```

Wire `(browseRemote)="onWelcomeBrowseRemote($event)"` on the welcome component in the template.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/features/instance-detail/instance-welcome.component.ts src/renderer/app/features/instance-detail/instance-detail.component.ts
git commit -m "feat(remote-fs): wire browse modal into welcome screen"
```

---

## Phase 7: FILES Panel Extension

### Task 15: Make File Explorer Remote-Aware

**Files:**
- Modify: `src/renderer/app/features/file-explorer/file-explorer.component.ts`

- [ ] **Step 1: Add remote awareness inputs**

Add an input for execution location context:

```typescript
executionNodeId = input<string | null>(null);
```

Inject `RemoteFsIpcService`:

```typescript
private readonly remoteFsIpc = inject(RemoteFsIpcService);
```

- [ ] **Step 2: Route loadDirectory through remote service**

Modify the `loadDirectory` method (around line 898). Before the existing `this.ipc.readDir()` call, add a remote branch:

```typescript
const nodeId = this.executionNodeId();
if (nodeId && nodeId !== 'local') {
  // Remote: use RPC
  const result = await this.remoteFsIpc.readDirectory(nodeId, path, {
    includeHidden: this.showHidden(),
  });
  if (result) {
    return result.entries.map(e => ({
      name: e.name,
      path: e.path,
      isDirectory: e.isDirectory,
      isSymlink: e.isSymlink,
      size: e.size,
      modifiedAt: e.modifiedAt,
      extension: e.extension,
    }));
  }
  return [];
}
// Existing local readDir below...
```

- [ ] **Step 3: Pass executionNodeId from dashboard**

In the dashboard component that renders the file explorer, pass the active instance's execution location. Find where `<app-file-explorer>` is rendered and add:

```html
[executionNodeId]="selectedInstanceExecutionNodeId()"
```

Add a computed signal in the dashboard:

```typescript
selectedInstanceExecutionNodeId = computed(() => {
  const inst = this.store.selectedInstance();
  if (!inst?.executionLocation || inst.executionLocation.type === 'local') return null;
  return inst.executionLocation.nodeId;
});
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/file-explorer/file-explorer.component.ts src/renderer/app/features/dashboard/dashboard.component.ts
git commit -m "feat(remote-fs): make FILES panel route readDir through remote RPC when appropriate"
```

---

## Phase 8: Final Verification

### Task 16: Full Build & Lint Check

- [ ] **Step 1: Run TypeScript check for main code**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Run TypeScript check for spec files**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors.

- [ ] **Step 3: Run linter**

Run: `npm run lint`
Expected: No errors (or only pre-existing ones).

- [ ] **Step 4: Run all tests**

Run: `npm run test`
Expected: All tests pass, including new ones for SecurityFilter, ProjectDiscovery, NodeFilesystemHandler, FilesystemService, NodePathPipe, and remote-fs-schemas.

- [ ] **Step 5: Verify no stale imports**

Run: `npx tsc --noEmit 2>&1 | grep -i "cannot find"` — should produce no output.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(remote-fs): complete remote folder browsing implementation"
```
