/**
 * LSP Manager - Language Server Protocol integration
 *
 * Provides code intelligence through language servers:
 * - Go to definition
 * - Find references
 * - Document/workspace symbols
 * - Hover information
 * - Diagnostics
 *
 * Supports TypeScript, JavaScript, Python, Go, and Rust.
 */

import { spawn, ChildProcess, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';

const logger = getLogger('LspManager');

// ============================================
// Types
// ============================================

export interface Position {
  line: number;    // 0-based
  character: number;  // 0-based
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  location: Location;
  containerName?: string;
}

export interface DocumentSymbol {
  name: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface HoverInfo {
  contents: string;
  range?: Range;
}

export interface Diagnostic {
  range: Range;
  severity: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
}

export type SymbolKind =
  | 'file' | 'module' | 'namespace' | 'package' | 'class' | 'method'
  | 'property' | 'field' | 'constructor' | 'enum' | 'interface'
  | 'function' | 'variable' | 'constant' | 'string' | 'number'
  | 'boolean' | 'array' | 'object' | 'key' | 'null' | 'enumMember'
  | 'struct' | 'event' | 'operator' | 'typeParameter';

export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

export type LspServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface LspServerInfo {
  id: string;
  name: string;
  languages: string[];
  extensions: string[];
  command: string;
  args: string[];
  rootPatterns: string[];  // Files that indicate project root
}

export interface LspClient {
  serverId: string;
  rootPath: string;
  process: ChildProcess;
  status: LspServerStatus;
  requestId: number;
  pendingRequests: Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>;
  diagnostics: Map<string, Diagnostic[]>;
  capabilities?: Record<string, unknown>;
}

// ============================================
// Server Definitions
// ============================================

const LSP_SERVERS: LspServerInfo[] = [
  {
    id: 'typescript',
    name: 'TypeScript Language Server',
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    rootPatterns: ['tsconfig.json', 'jsconfig.json', 'package.json'],
  },
  {
    id: 'python',
    name: 'Pyright Language Server',
    languages: ['python'],
    extensions: ['.py', '.pyi'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    rootPatterns: ['pyproject.toml', 'setup.py', 'requirements.txt', 'pyrightconfig.json'],
  },
  {
    id: 'go',
    name: 'Go Language Server (gopls)',
    languages: ['go'],
    extensions: ['.go'],
    command: 'gopls',
    args: ['serve'],
    rootPatterns: ['go.mod', 'go.sum'],
  },
  {
    id: 'rust',
    name: 'Rust Analyzer',
    languages: ['rust'],
    extensions: ['.rs'],
    command: 'rust-analyzer',
    args: [],
    rootPatterns: ['Cargo.toml'],
  },
];

// Symbol kind number to name mapping (LSP spec)
const SYMBOL_KIND_MAP: Record<number, SymbolKind> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class',
  6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum',
  11: 'interface', 12: 'function', 13: 'variable', 14: 'constant',
  15: 'string', 16: 'number', 17: 'boolean', 18: 'array', 19: 'object',
  20: 'key', 21: 'null', 22: 'enumMember', 23: 'struct', 24: 'event',
  25: 'operator', 26: 'typeParameter',
};

const SEVERITY_MAP: Record<number, DiagnosticSeverity> = {
  1: 'error', 2: 'warning', 3: 'information', 4: 'hint',
};

// ============================================
// LSP Manager Class
// ============================================

export class LspManager extends EventEmitter {
  private clients: Map<string, LspClient> = new Map();  // key: serverId:rootPath
  private availableServers: Map<string, boolean> = new Map();  // serverId -> available

  constructor() {
    super();
    this.checkServerAvailability();
    registerCleanup(() => this.shutdown());
  }

  /**
   * Check which LSP servers are available on the system
   */
  private checkServerAvailability(): void {
    for (const server of LSP_SERVERS) {
      try {
        execFileSync('which', [server.command], { encoding: 'utf-8', timeout: 5000 });
        this.availableServers.set(server.id, true);
        logger.info('LSP server available', { serverName: server.name });
      } catch {
        this.availableServers.set(server.id, false);
        logger.info('LSP server not available', { serverName: server.name, command: server.command });
      }
    }
  }

  /**
   * Get list of available LSP servers
   */
  getAvailableServers(): LspServerInfo[] {
    return LSP_SERVERS.filter(s => this.availableServers.get(s.id));
  }

  /**
   * Find the appropriate LSP server for a file
   */
  private findServerForFile(filePath: string): LspServerInfo | null {
    const ext = path.extname(filePath).toLowerCase();
    for (const server of LSP_SERVERS) {
      if (server.extensions.includes(ext) && this.availableServers.get(server.id)) {
        return server;
      }
    }
    return null;
  }

  /**
   * Find project root for a file based on server's root patterns
   */
  private findProjectRoot(filePath: string, server: LspServerInfo): string {
    let dir = path.dirname(path.resolve(filePath));
    const root = path.parse(dir).root;

    while (dir !== root) {
      for (const pattern of server.rootPatterns) {
        if (fs.existsSync(path.join(dir, pattern))) {
          return dir;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // Fall back to file's directory
    return path.dirname(path.resolve(filePath));
  }

  /**
   * Get or create an LSP client for a file
   */
  private async getClientForFile(filePath: string): Promise<LspClient | null> {
    const server = this.findServerForFile(filePath);
    if (!server) return null;

    const rootPath = this.findProjectRoot(filePath, server);
    const clientKey = `${server.id}:${rootPath}`;

    // Return existing client if available
    let client = this.clients.get(clientKey);
    if (client && client.status === 'running') {
      return client;
    }

    // Start new client
    return this.startClient(server, rootPath);
  }

  /**
   * Start an LSP client
   */
  private async startClient(server: LspServerInfo, rootPath: string): Promise<LspClient | null> {
    const clientKey = `${server.id}:${rootPath}`;

    try {
      const proc = spawn(server.command, server.args, {
        cwd: rootPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const client: LspClient = {
        serverId: server.id,
        rootPath,
        process: proc,
        status: 'starting',
        requestId: 0,
        pendingRequests: new Map(),
        diagnostics: new Map(),
      };

      this.clients.set(clientKey, client);

      // Set up message handling
      this.setupMessageHandling(client);

      // Initialize the server
      await this.initializeServer(client, server, rootPath);

      client.status = 'running';
      this.emit('server:started', server.id, rootPath);

      return client;
    } catch (error) {
      logger.error('Failed to start LSP server', error instanceof Error ? error : undefined, { serverId: server.id });
      return null;
    }
  }

  /**
   * Set up JSON-RPC message handling
   */
  private setupMessageHandling(client: LspClient): void {
    const rl = readline.createInterface({
      input: client.process.stdout!,
      terminal: false,
    });

    let buffer = '';
    let contentLength = -1;

    rl.on('line', (line) => {
      if (line.startsWith('Content-Length: ')) {
        contentLength = parseInt(line.slice(16), 10);
      } else if (line === '') {
        // Header complete, read body
      }
    });

    client.process.stdout!.on('data', (data: Buffer) => {
      buffer += data.toString();

      while (true) {
        // Parse headers
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const headers = buffer.slice(0, headerEnd);
        const lengthMatch = headers.match(/Content-Length: (\d+)/);
        if (!lengthMatch) break;

        const contentLength = parseInt(lengthMatch[1], 10);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;

        if (buffer.length < bodyEnd) break;

        const body = buffer.slice(bodyStart, bodyEnd);
        buffer = buffer.slice(bodyEnd);

        try {
          const message = JSON.parse(body);
          this.handleMessage(client, message);
        } catch (e) {
          logger.error('Failed to parse LSP message', e instanceof Error ? e : undefined);
        }
      }
    });

    client.process.stderr!.on('data', (data: Buffer) => {
      logger.error('LSP stderr', undefined, { serverId: client.serverId, output: data.toString() });
    });

    client.process.on('exit', (code) => {
      client.status = 'stopped';
      this.emit('server:stopped', client.serverId, client.rootPath, code);
    });
  }

  /**
   * Handle incoming LSP message
   */
  private handleMessage(client: LspClient, message: any): void {
    if ('id' in message && message.id !== undefined) {
      // Response to a request
      const pending = client.pendingRequests.get(message.id);
      if (pending) {
        client.pendingRequests.delete(message.id);
        if ('error' in message) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if ('method' in message) {
      // Notification or request from server
      this.handleNotification(client, message.method, message.params);
    }
  }

  /**
   * Handle server notification
   */
  private handleNotification(client: LspClient, method: string, params: any): void {
    switch (method) {
      case 'textDocument/publishDiagnostics':
        const uri = params.uri;
        const diagnostics = params.diagnostics.map((d: any) => ({
          range: d.range,
          severity: SEVERITY_MAP[d.severity] || 'information',
          code: d.code,
          source: d.source,
          message: d.message,
        }));
        client.diagnostics.set(uri, diagnostics);
        this.emit('diagnostics', client.serverId, uri, diagnostics);
        break;

      case 'window/logMessage':
      case 'window/showMessage':
        logger.info('LSP server message', { serverId: client.serverId, message: params.message });
        break;
    }
  }

  /**
   * Send a JSON-RPC request
   */
  private async sendRequest<T>(client: LspClient, method: string, params: any): Promise<T> {
    const id = ++client.requestId;

    const message = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

    return new Promise((resolve, reject) => {
      client.pendingRequests.set(id, { resolve: resolve as any, reject });
      client.process.stdin!.write(content);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (client.pendingRequests.has(id)) {
          client.pendingRequests.delete(id);
          reject(new Error('LSP request timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Send a notification (no response expected)
   */
  private sendNotification(client: LspClient, method: string, params: any): void {
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });

    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    client.process.stdin!.write(content);
  }

  /**
   * Initialize the LSP server
   */
  private async initializeServer(client: LspClient, server: LspServerInfo, rootPath: string): Promise<void> {
    const result = await this.sendRequest<any>(client, 'initialize', {
      processId: process.pid,
      rootPath,
      rootUri: `file://${rootPath}`,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
          completion: { dynamicRegistration: false, completionItem: { snippetSupport: false } },
          hover: { dynamicRegistration: false, contentFormat: ['plaintext', 'markdown'] },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
          workspaceFolders: true,
          symbol: { dynamicRegistration: false },
        },
      },
      workspaceFolders: [{ uri: `file://${rootPath}`, name: path.basename(rootPath) }],
    });

    client.capabilities = result.capabilities;

    // Send initialized notification
    this.sendNotification(client, 'initialized', {});
  }

  /**
   * Notify server about file open
   */
  private async openFile(client: LspClient, filePath: string): Promise<void> {
    const uri = `file://${path.resolve(filePath)}`;
    const content = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath);

    let languageId = 'plaintext';
    if (['.ts', '.tsx'].includes(ext)) languageId = 'typescript';
    else if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) languageId = 'javascript';
    else if (['.py', '.pyi'].includes(ext)) languageId = 'python';
    else if (ext === '.go') languageId = 'go';
    else if (ext === '.rs') languageId = 'rust';

    this.sendNotification(client, 'textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });

    // Wait a bit for diagnostics
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Go to definition
   */
  async goToDefinition(filePath: string, line: number, character: number): Promise<Location[] | null> {
    const client = await this.getClientForFile(filePath);
    if (!client) return null;

    await this.openFile(client, filePath);

    try {
      const result = await this.sendRequest<any>(client, 'textDocument/definition', {
        textDocument: { uri: `file://${path.resolve(filePath)}` },
        position: { line, character },
      });

      if (!result) return [];

      // Normalize to array
      const locations = Array.isArray(result) ? result : [result];
      return locations.map((loc: any) => ({
        uri: loc.uri || loc.targetUri,
        range: loc.range || loc.targetRange,
      }));
    } catch (error) {
      logger.error('Definition request failed', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Find references
   */
  async findReferences(filePath: string, line: number, character: number, includeDeclaration = true): Promise<Location[] | null> {
    const client = await this.getClientForFile(filePath);
    if (!client) return null;

    await this.openFile(client, filePath);

    try {
      const result = await this.sendRequest<any>(client, 'textDocument/references', {
        textDocument: { uri: `file://${path.resolve(filePath)}` },
        position: { line, character },
        context: { includeDeclaration },
      });

      return result || [];
    } catch (error) {
      logger.error('References request failed', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Get hover information
   */
  async hover(filePath: string, line: number, character: number): Promise<HoverInfo | null> {
    const client = await this.getClientForFile(filePath);
    if (!client) return null;

    await this.openFile(client, filePath);

    try {
      const result = await this.sendRequest<any>(client, 'textDocument/hover', {
        textDocument: { uri: `file://${path.resolve(filePath)}` },
        position: { line, character },
      });

      if (!result) return null;

      let contents = '';
      if (typeof result.contents === 'string') {
        contents = result.contents;
      } else if (Array.isArray(result.contents)) {
        contents = result.contents.map((c: any) => typeof c === 'string' ? c : c.value).join('\n');
      } else if (result.contents.value) {
        contents = result.contents.value;
      }

      return {
        contents,
        range: result.range,
      };
    } catch (error) {
      logger.error('Hover request failed', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Get document symbols (outline)
   */
  async getDocumentSymbols(filePath: string): Promise<DocumentSymbol[] | SymbolInfo[] | null> {
    const client = await this.getClientForFile(filePath);
    if (!client) return null;

    await this.openFile(client, filePath);

    try {
      const result = await this.sendRequest<any>(client, 'textDocument/documentSymbol', {
        textDocument: { uri: `file://${path.resolve(filePath)}` },
      });

      if (!result) return [];

      // Can be DocumentSymbol[] or SymbolInformation[]
      return result.map((s: any) => {
        if ('selectionRange' in s) {
          // DocumentSymbol
          return {
            name: s.name,
            kind: SYMBOL_KIND_MAP[s.kind] || 'variable',
            range: s.range,
            selectionRange: s.selectionRange,
            children: s.children?.map((c: any) => this.mapDocumentSymbol(c)),
          };
        } else {
          // SymbolInformation
          return {
            name: s.name,
            kind: SYMBOL_KIND_MAP[s.kind] || 'variable',
            location: s.location,
            containerName: s.containerName,
          };
        }
      });
    } catch (error) {
      logger.error('Document symbols request failed', error instanceof Error ? error : undefined);
      return null;
    }
  }

  private mapDocumentSymbol(s: any): DocumentSymbol {
    return {
      name: s.name,
      kind: SYMBOL_KIND_MAP[s.kind] || 'variable',
      range: s.range,
      selectionRange: s.selectionRange,
      children: s.children?.map((c: any) => this.mapDocumentSymbol(c)),
    };
  }

  /**
   * Search workspace symbols
   */
  async workspaceSymbol(query: string, rootPath: string): Promise<SymbolInfo[] | null> {
    // Find any client for this root
    let client: LspClient | null = null;
    for (const c of this.clients.values()) {
      if (c.rootPath === rootPath && c.status === 'running') {
        client = c;
        break;
      }
    }

    if (!client) {
      // Try to start a TypeScript server as default
      const tsServer = LSP_SERVERS.find(s => s.id === 'typescript');
      if (tsServer && this.availableServers.get('typescript')) {
        client = await this.startClient(tsServer, rootPath);
      }
    }

    if (!client) return null;

    try {
      const result = await this.sendRequest<any>(client, 'workspace/symbol', { query });

      return (result || []).map((s: any) => ({
        name: s.name,
        kind: SYMBOL_KIND_MAP[s.kind] || 'variable',
        location: s.location,
        containerName: s.containerName,
      }));
    } catch (error) {
      logger.error('Workspace symbol request failed', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Get diagnostics for a file
   */
  async getDiagnostics(filePath: string): Promise<Diagnostic[] | null> {
    const client = await this.getClientForFile(filePath);
    if (!client) return null;

    await this.openFile(client, filePath);

    // Wait for diagnostics to come in
    await new Promise(resolve => setTimeout(resolve, 1000));

    const uri = `file://${path.resolve(filePath)}`;
    return client.diagnostics.get(uri) || [];
  }

  /**
   * Get all diagnostics for all open files
   */
  getAllDiagnostics(): Map<string, Diagnostic[]> {
    const allDiagnostics = new Map<string, Diagnostic[]>();

    for (const client of this.clients.values()) {
      for (const [uri, diagnostics] of client.diagnostics) {
        const existing = allDiagnostics.get(uri) || [];
        allDiagnostics.set(uri, [...existing, ...diagnostics]);
      }
    }

    return allDiagnostics;
  }

  /**
   * Get status of all clients
   */
  getStatus(): Array<{ serverId: string; rootPath: string; status: LspServerStatus }> {
    return Array.from(this.clients.values()).map(c => ({
      serverId: c.serverId,
      rootPath: c.rootPath,
      status: c.status,
    }));
  }

  /**
   * Shutdown all clients
   */
  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await this.sendRequest(client, 'shutdown', null);
        this.sendNotification(client, 'exit', null);
      } catch {
        // Ignore errors during shutdown
      }
      client.process.kill();
    }
    this.clients.clear();
  }

  /**
   * Check if LSP is available for a file type
   */
  isAvailableForFile(filePath: string): boolean {
    return this.findServerForFile(filePath) !== null;
  }
}

// ============================================
// Singleton Instance
// ============================================

let lspManager: LspManager | null = null;

export function getLspManager(): LspManager {
  if (!lspManager) {
    lspManager = new LspManager();
  }
  return lspManager;
}
