import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { getLogger } from '../logging/logger';
import { getLspManager } from '../workspace/lsp-manager';
import {
  type LspWorkerRequest,
  LspWorkerRequestSchema,
  type LspWorkerResponse,
} from './protocol';

const logger = getLogger('LspWorker');
const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py', '.pyi'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
};

async function findRepresentativeFile(workspacePath: string, language: string): Promise<string | null> {
  const extensions = LANGUAGE_EXTENSIONS[language.toLowerCase()] ?? [];
  if (extensions.length === 0) {
    return null;
  }

  const visit = async (dirPath: string): Promise<string | null> => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORES.has(entry.name)) {
          continue;
        }
        const nested = await visit(path.join(dirPath, entry.name));
        if (nested) {
          return nested;
        }
        continue;
      }

      if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        return path.join(dirPath, entry.name);
      }
    }

    return null;
  };

  try {
    return await visit(workspacePath);
  } catch {
    return null;
  }
}

async function handleRequest(request: LspWorkerRequest): Promise<unknown> {
  const lsp = getLspManager();

  switch (request.type) {
    case 'ping':
      return { pong: true };
    case 'shutdown':
      await lsp.shutdown();
      return { stopped: true };
    case 'warm-workspace': {
      const filePath = await findRepresentativeFile(request.payload.workspacePath, request.payload.language);
      if (!filePath) {
        return { ready: false, filePath: null };
      }

      await lsp.getDocumentSymbols(filePath);
      return { ready: true, filePath };
    }
    case 'get-available-servers':
      return lsp.getAvailableServers();
    case 'get-status':
      return lsp.getStatus();
    case 'is-available-for-file':
      return { available: lsp.isAvailableForFile(request.payload.filePath) };
    case 'go-to-definition':
      return lsp.goToDefinition(
        request.payload.filePath,
        request.payload.line,
        request.payload.character,
      );
    case 'find-references':
      return lsp.findReferences(
        request.payload.filePath,
        request.payload.line,
        request.payload.character,
        request.payload.includeDeclaration ?? true,
      );
    case 'hover':
      return lsp.hover(
        request.payload.filePath,
        request.payload.line,
        request.payload.character,
      );
    case 'document-symbols':
      return lsp.getDocumentSymbols(request.payload.filePath);
    case 'workspace-symbols':
      return lsp.workspaceSymbol(request.payload.query, request.payload.rootPath);
    case 'diagnostics':
      return lsp.getDiagnostics(request.payload.filePath);
    case 'find-implementations':
      return lsp.findImplementations(
        request.payload.filePath,
        request.payload.line,
        request.payload.character,
      );
    case 'incoming-calls':
      return lsp.getIncomingCalls(
        request.payload.filePath,
        request.payload.line,
        request.payload.character,
      );
    case 'outgoing-calls':
      return lsp.getOutgoingCalls(
        request.payload.filePath,
        request.payload.line,
        request.payload.character,
      );
  }
}

if (!parentPort) {
  throw new Error('LspWorker requires a parentPort');
}

parentPort.on('message', async (rawMessage: unknown) => {
  let requestId = -1;

  try {
    const request = LspWorkerRequestSchema.parse(rawMessage);
    requestId = request.id;
    const result = await handleRequest(request);
    const response: LspWorkerResponse = { id: request.id, ok: true, result };
    parentPort?.postMessage(response);

    if (request.type === 'shutdown') {
      setImmediate(() => process.exit(0));
    }
  } catch (error) {
    const response: LspWorkerResponse = {
      id: requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    logger.warn('LSP worker request failed', {
      requestId,
      error: response.error,
    });
    parentPort?.postMessage(response);
  }
});
