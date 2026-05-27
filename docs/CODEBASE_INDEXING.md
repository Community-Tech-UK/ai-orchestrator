# Codebase Indexing

AI Orchestrator uses `codemem` as the canonical automatic code index. The older RLM BM25 + embedding codebase index still exists for diagnostics and manual comparison, but it is no longer the default path for workspace-open indexing or injected code context.

## Current Paths

| Path | Default | Purpose |
|------|---------|---------|
| `codemem` | On | Automatic workspace indexing, file-change updates, symbol navigation, and indexed context retrieval |
| Legacy RLM codebase index | Off | Manual diagnostics for the older BM25/vector search path |

`DEFAULT_SETTINGS.codebaseAutoIndexEnabled` is `false`. The related setting is labeled as legacy in the settings UI so it is clear that enabling it runs the heavier RLM indexing path.

## Codemem Indexing Flow

1. A workspace is discovered or opened.
2. `codemem` warms the workspace in its index worker.
3. The worker scans source files with the repository ignore rules and built-in generated-folder exclusions.
4. Chunks are written to CAS and searchable metadata is written to the `workspace_chunks` table.
5. The SQLite FTS table stores contentless rows keyed to the chunk rows; snippets are loaded from CAS when results are returned.
6. Symbols are written to the codemem symbol index for MCP navigation tools.

Generated and dependency folders are ignored by default, including `node_modules`, `dist`, `build`, `.git`, and similar output directories. These paths should stay excluded unless a specific diagnostic task needs them.

## File Changes

Codemem owns the watcher for indexed workspaces. File creates and updates re-index only the affected file's chunks and symbols. File deletes remove the manifest entry, workspace chunk rows, FTS rows, and symbol rows for that file.

This keeps the automatic index current without starting the legacy RLM indexer on every workspace-open event.

## Searching

The main-process retrieval path is `CodeRetrievalService`:

```typescript
import { getCodeRetrievalService } from './codemem';

const results = await getCodeRetrievalService().search({
  workspacePath: '/path/to/workspace',
  query: 'issue session token',
  limit: 10,
});
```

The service resolves the workspace root, asks codemem to warm the index if needed, queries the codemem FTS rows, loads chunk text from CAS, and returns bounded snippets. If the codemem index is still cold, it falls back to a bounded `rg` search with generated/dependency folders excluded.

## Indexed Context

`IndexedCodebaseContextService` now uses `CodeRetrievalService`. The prompt block remains:

```text
[Indexed Codebase Context]
...
[/Indexed Codebase Context]
```

Agents should treat this block as a starting point and verify important details against repository files before editing.

## Legacy RLM Index

Manual legacy index buttons and IPC handlers remain available for diagnostics. They are useful when comparing the older hybrid BM25/vector retrieval path against codemem, or when investigating regressions in legacy codebase-search behavior.

The legacy index runs through a background indexing lane instead of executing the indexing loop in the Electron main process. It should not be enabled as the normal automatic index unless debugging the legacy path.

## Operational Notes

- Prefer codemem tools for code navigation and symbol lookup.
- Prefer plain `rg` for one-off text search or file discovery.
- Do not add a vector database to the canonical path until it has benchmark evidence, packaging validation, and a clear quality gain over codemem FTS plus symbols.
- Keep generated/dependency folders excluded from automatic indexing by default.

## See Also

- [Codebase Indexing Performance](./CODEBASE_INDEXING_PERFORMANCE.md)
- [Codebase Indexing API](./CODEBASE_INDEXING_API.md)
