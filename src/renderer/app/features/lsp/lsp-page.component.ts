/**
 * LSP Page
 * Language Server Protocol integration — definitions, references, symbols, and diagnostics.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { LspIpcService } from '../../core/services/ipc/lsp-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

// ============================================================
// Local interfaces
// ============================================================

interface LspServer {
  id: string;
  name: string;
  languages: string[];
  status: 'running' | 'stopped' | 'error';
}

interface DocumentSymbol {
  name: string;
  kind: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  children?: DocumentSymbol[];
}

interface DiagnosticItem {
  line: number;
  character: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
}

interface LocationItem {
  filePath: string;
  line: number;
  character: number;
  preview?: string;
}

// ============================================================
// Symbol kind icon map
// ============================================================

const SYMBOL_KIND_ICONS: Record<string, string> = {
  File: 'F',
  Module: 'M',
  Namespace: 'N',
  Package: 'P',
  Class: 'C',
  Method: 'm',
  Property: 'p',
  Field: 'f',
  Constructor: 'c',
  Enum: 'E',
  Interface: 'I',
  Function: 'fn',
  Variable: 'v',
  Constant: 'K',
  String: 's',
  Number: '#',
  Boolean: 'b',
  Array: 'A',
  Object: 'O',
  Key: 'k',
  Null: '∅',
  EnumMember: 'e',
  Struct: 'S',
  Event: 'ev',
  Operator: 'op',
  TypeParameter: 'T',
};

function symbolKindIcon(kind: string): string {
  return SYMBOL_KIND_ICONS[kind] ?? '?';
}

@Component({
  selector: 'app-lsp-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './lsp-page.component.html',
  styleUrl: './lsp-page.component.scss',
})
export class LspPageComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly lspIpc = inject(LspIpcService);

  // ---- Server status ----
  readonly servers = signal<LspServer[]>([]);

  // ---- Document symbols (left panel) ----
  readonly symbolFilePath = signal('');
  readonly documentSymbols = signal<DocumentSymbol[]>([]);
  readonly symbolsLoading = signal(false);
  readonly symbolsLoaded = signal(false);
  readonly selectedSymbol = signal<DocumentSymbol | null>(null);

  // ---- Hover / detail (center panel) ----
  readonly hoverInfo = signal<string | null>(null);
  readonly hoverLoading = signal(false);
  readonly definitionLocations = signal<LocationItem[]>([]);
  readonly referenceLocations = signal<LocationItem[]>([]);

  // ---- Workspace symbols (right panel) ----
  readonly workspaceQuery = signal('');
  readonly workspaceRootPath = signal('');
  readonly workspaceSymbols = signal<DocumentSymbol[]>([]);
  readonly workspaceLoading = signal(false);
  readonly workspaceSearched = signal(false);

  // ---- Diagnostics (bottom panel) ----
  readonly diagnosticsFilePath = signal('');
  readonly diagnostics = signal<DiagnosticItem[]>([]);
  readonly diagnosticsLoading = signal(false);
  readonly diagnosticsLoaded = signal(false);

  // ---- Global state ----
  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  // ---- Derived ----
  readonly hasSelectedSymbol = computed(() => this.selectedSymbol() !== null);

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  kindIcon(kind: string): string {
    return symbolKindIcon(kind);
  }

  // ============================================================
  // Refresh (header button)
  // ============================================================

  async refresh(): Promise<void> {
    this.working.set(true);
    this.clearMessages();

    try {
      await Promise.all([this.loadServers(), this.loadStatus()]);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  // ============================================================
  // Server status
  // ============================================================

  private async loadServers(): Promise<void> {
    const response = await this.lspIpc.lspGetAvailableServers();
    if (!response.success) return;

    const raw = response.data as unknown[];
    if (!Array.isArray(raw)) return;

    const servers = raw
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item): LspServer => ({
        id: String(item['id'] ?? item['name'] ?? 'unknown'),
        name: String(item['name'] ?? item['id'] ?? 'Unknown'),
        languages: Array.isArray(item['languages'])
          ? (item['languages'] as unknown[]).map(String)
          : [],
        status: this.coerceServerStatus(item['status']),
      }));

    this.servers.set(servers);
  }

  private async loadStatus(): Promise<void> {
    const response = await this.lspIpc.lspGetStatus();
    if (!response.success) return;

    // Merge running-client status into server list when available
    const statusMap = response.data as Record<string, unknown> | null;
    if (!statusMap || typeof statusMap !== 'object') return;

    this.servers.update((current) =>
      current.map((srv) => {
        const clientStatus = statusMap[srv.id];
        if (clientStatus === 'running') return { ...srv, status: 'running' as const };
        if (clientStatus === 'stopped') return { ...srv, status: 'stopped' as const };
        if (clientStatus === 'error') return { ...srv, status: 'error' as const };
        return srv;
      })
    );
  }

  private coerceServerStatus(raw: unknown): LspServer['status'] {
    if (raw === 'running') return 'running';
    if (raw === 'stopped') return 'stopped';
    if (raw === 'error') return 'error';
    return 'stopped';
  }

  // ============================================================
  // Document symbols
  // ============================================================

  async loadDocumentSymbols(): Promise<void> {
    const filePath = this.symbolFilePath();
    if (!filePath) return;

    this.symbolsLoading.set(true);
    this.symbolsLoaded.set(false);
    this.documentSymbols.set([]);
    this.selectedSymbol.set(null);
    this.hoverInfo.set(null);
    this.definitionLocations.set([]);
    this.referenceLocations.set([]);
    this.clearMessages();

    try {
      const response = await this.lspIpc.lspDocumentSymbols(filePath);
      this.assertSuccess(response, 'Failed to load document symbols.');
      const symbols = this.parseSymbols(response.data);
      this.documentSymbols.set(symbols);
      this.symbolsLoaded.set(true);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.symbolsLoading.set(false);
    }
  }

  // ============================================================
  // Symbol selection & hover
  // ============================================================

  selectSymbol(sym: DocumentSymbol): void {
    this.selectedSymbol.set(sym);
    this.hoverInfo.set(null);
    this.definitionLocations.set([]);
    this.referenceLocations.set([]);
    void this.loadHover(sym);
  }

  private async loadHover(sym: DocumentSymbol): Promise<void> {
    const filePath = this.symbolFilePath();
    if (!filePath) return;

    this.hoverLoading.set(true);

    try {
      const response = await this.lspIpc.lspHover(
        filePath,
        sym.range.start.line,
        sym.range.start.character,
      );
      if (response.success && response.data) {
        const content = this.extractHoverContent(response.data);
        this.hoverInfo.set(content);
      }
    } catch {
      // Non-critical — hover is best-effort
    } finally {
      this.hoverLoading.set(false);
    }
  }

  // ============================================================
  // Go to definition
  // ============================================================

  async goToDefinition(): Promise<void> {
    const sym = this.selectedSymbol();
    const filePath = this.symbolFilePath();
    if (!sym || !filePath) return;

    this.working.set(true);
    this.definitionLocations.set([]);
    this.clearMessages();

    try {
      const response = await this.lspIpc.lspGoToDefinition(
        filePath,
        sym.range.start.line,
        sym.range.start.character,
      );
      this.assertSuccess(response, 'Failed to find definition.');
      const locations = this.parseLocations(response.data);
      this.definitionLocations.set(locations);
      if (locations.length === 0) {
        this.infoMessage.set('No definition found.');
      }
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  // ============================================================
  // Find references
  // ============================================================

  async findReferences(): Promise<void> {
    const sym = this.selectedSymbol();
    const filePath = this.symbolFilePath();
    if (!sym || !filePath) return;

    this.working.set(true);
    this.referenceLocations.set([]);
    this.clearMessages();

    try {
      const response = await this.lspIpc.lspFindReferences(
        filePath,
        sym.range.start.line,
        sym.range.start.character,
        true,
      );
      this.assertSuccess(response, 'Failed to find references.');
      const locations = this.parseLocations(response.data);
      this.referenceLocations.set(locations);
      if (locations.length === 0) {
        this.infoMessage.set('No references found.');
      }
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  // ============================================================
  // Workspace symbol search
  // ============================================================

  async searchWorkspaceSymbols(): Promise<void> {
    const query = this.workspaceQuery();
    const rootPath = this.workspaceRootPath();
    if (!query || !rootPath) return;

    this.workspaceLoading.set(true);
    this.workspaceSearched.set(false);
    this.workspaceSymbols.set([]);
    this.clearMessages();

    try {
      const response = await this.lspIpc.lspWorkspaceSymbols(query, rootPath);
      this.assertSuccess(response, 'Failed to search workspace symbols.');
      const symbols = this.parseSymbols(response.data);
      this.workspaceSymbols.set(symbols);
      this.workspaceSearched.set(true);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.workspaceLoading.set(false);
    }
  }

  // ============================================================
  // Diagnostics
  // ============================================================

  async loadDiagnostics(): Promise<void> {
    const filePath = this.diagnosticsFilePath();
    if (!filePath) return;

    this.diagnosticsLoading.set(true);
    this.diagnosticsLoaded.set(false);
    this.diagnostics.set([]);
    this.clearMessages();

    try {
      const response = await this.lspIpc.lspDiagnostics(filePath);
      this.assertSuccess(response, 'Failed to load diagnostics.');
      const items = this.parseDiagnostics(response.data);
      this.diagnostics.set(items);
      this.diagnosticsLoaded.set(true);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.diagnosticsLoading.set(false);
    }
  }

  // ============================================================
  // Shutdown
  // ============================================================

  async shutdown(): Promise<void> {
    this.working.set(true);
    this.clearMessages();

    try {
      const response = await this.lspIpc.lspShutdown();
      this.assertSuccess(response, 'Failed to shut down LSP servers.');
      this.servers.update((current) =>
        current.map((srv) => ({ ...srv, status: 'stopped' as const }))
      );
      this.infoMessage.set('All LSP servers shut down.');
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  // ============================================================
  // Input handlers
  // ============================================================

  onSymbolFilePathInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.symbolFilePath.set(target.value);
  }

  onDiagnosticsFilePathInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.diagnosticsFilePath.set(target.value);
  }

  onWorkspaceQueryInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.workspaceQuery.set(target.value);
  }

  onWorkspaceRootPathInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.workspaceRootPath.set(target.value);
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private parseSymbols(data: unknown): DocumentSymbol[] {
    if (!Array.isArray(data)) return [];

    return data
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item): DocumentSymbol => ({
        name: String(item['name'] ?? 'unknown'),
        kind: String(item['kind'] ?? 'Unknown'),
        range: this.parseRange(item['range']),
        children: Array.isArray(item['children'])
          ? this.parseSymbols(item['children'])
          : undefined,
      }));
  }

  private parseRange(raw: unknown): DocumentSymbol['range'] {
    const fallback = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    if (!raw || typeof raw !== 'object') return fallback;

    const r = raw as Record<string, unknown>;
    const start = r['start'] as Record<string, unknown> | undefined;
    const end = r['end'] as Record<string, unknown> | undefined;

    return {
      start: {
        line: Number(start?.['line'] ?? 0),
        character: Number(start?.['character'] ?? 0),
      },
      end: {
        line: Number(end?.['line'] ?? 0),
        character: Number(end?.['character'] ?? 0),
      },
    };
  }

  private parseLocations(data: unknown): LocationItem[] {
    const raw = Array.isArray(data) ? data : (data ? [data] : []);

    return raw
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item): LocationItem => {
        // Support both { filePath, line, character } and LSP Location { uri, range }
        const filePath = String(item['filePath'] ?? item['uri'] ?? '');
        const range = item['range'] as Record<string, unknown> | undefined;
        const start = range?.['start'] as Record<string, unknown> | undefined;
        const line = Number(item['line'] ?? start?.['line'] ?? 0);
        const character = Number(item['character'] ?? start?.['character'] ?? 0);
        const preview = typeof item['preview'] === 'string' ? item['preview'] : undefined;

        return { filePath, line, character, preview };
      });
  }

  private parseDiagnostics(data: unknown): DiagnosticItem[] {
    if (!Array.isArray(data)) return [];

    return data
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item): DiagnosticItem => {
        const range = item['range'] as Record<string, unknown> | undefined;
        const start = range?.['start'] as Record<string, unknown> | undefined;
        const line = Number(item['line'] ?? start?.['line'] ?? 0);
        const character = Number(item['character'] ?? start?.['character'] ?? 0);
        const severity = this.coerceSeverity(item['severity']);
        const message = String(item['message'] ?? '');
        const source = typeof item['source'] === 'string' ? item['source'] : undefined;

        return { line, character, severity, message, source };
      });
  }

  private coerceSeverity(raw: unknown): DiagnosticItem['severity'] {
    // LSP uses numeric severity: 1=error, 2=warning, 3=info, 4=hint
    if (raw === 1 || raw === 'error') return 'error';
    if (raw === 2 || raw === 'warning') return 'warning';
    if (raw === 3 || raw === 'info') return 'info';
    if (raw === 4 || raw === 'hint') return 'hint';
    return 'info';
  }

  private extractHoverContent(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      // LSP hover result has { contents: MarkupContent | MarkedString | ... }
      const contents = d['contents'];
      if (typeof contents === 'string') return contents;
      if (contents && typeof contents === 'object') {
        const c = contents as Record<string, unknown>;
        if (typeof c['value'] === 'string') return c['value'];
      }
    }
    return JSON.stringify(data, null, 2);
  }

  private assertSuccess(response: IpcResponse, fallback: string): void {
    if (!response.success) {
      throw new Error(response.error?.message ?? fallback);
    }
  }

  private clearMessages(): void {
    this.errorMessage.set(null);
    this.infoMessage.set(null);
  }
}
