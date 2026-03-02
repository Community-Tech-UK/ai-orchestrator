/**
 * LSP IPC Handlers
 * Handles Language Server Protocol operations
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getLspManager } from '../../workspace/lsp-manager';
import {
  validateIpcPayload,
  LspPositionPayloadSchema,
  LspFindReferencesPayloadSchema,
  LspFilePayloadSchema,
  LspWorkspaceSymbolPayloadSchema,
} from '../../../shared/validation/ipc-schemas';

export function registerLspHandlers(): void {
  const lsp = getLspManager();

  // Get available LSP servers
  ipcMain.handle(
    IPC_CHANNELS.LSP_GET_AVAILABLE_SERVERS,
    async (): Promise<IpcResponse> => {
      try {
        const servers = lsp.getAvailableServers();
        return {
          success: true,
          data: servers
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LSP_GET_AVAILABLE_SERVERS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get LSP client status
  ipcMain.handle(
    IPC_CHANNELS.LSP_GET_STATUS,
    async (): Promise<IpcResponse> => {
      try {
        const status = lsp.getStatus();
        return {
          success: true,
          data: status
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LSP_GET_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Go to definition
  ipcMain.handle(
    IPC_CHANNELS.LSP_GO_TO_DEFINITION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LspPositionPayloadSchema, payload, 'LSP_GO_TO_DEFINITION');
        const locations = await lsp.goToDefinition(
          validated.filePath,
          validated.line,
          validated.character
        );
        return {
          success: true,
          data: locations
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LSP_GO_TO_DEFINITION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Find references
  ipcMain.handle(
    IPC_CHANNELS.LSP_FIND_REFERENCES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LspFindReferencesPayloadSchema, payload, 'LSP_FIND_REFERENCES');
        const locations = await lsp.findReferences(
          validated.filePath,
          validated.line,
          validated.character,
          validated.includeDeclaration ?? true
        );
        return {
          success: true,
          data: locations
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LSP_FIND_REFERENCES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Hover
  ipcMain.handle(
    IPC_CHANNELS.LSP_HOVER,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LspPositionPayloadSchema, payload, 'LSP_HOVER');
        const hover = await lsp.hover(
          validated.filePath,
          validated.line,
          validated.character
        );
        return {
          success: true,
          data: hover
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LSP_HOVER_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Document symbols
  ipcMain.handle(
    IPC_CHANNELS.LSP_DOCUMENT_SYMBOLS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LspFilePayloadSchema, payload, 'LSP_DOCUMENT_SYMBOLS');
        const symbols = await lsp.getDocumentSymbols(validated.filePath);
        return {
          success: true,
          data: symbols
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LSP_DOCUMENT_SYMBOLS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Workspace symbols
  ipcMain.handle(
    IPC_CHANNELS.LSP_WORKSPACE_SYMBOLS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LspWorkspaceSymbolPayloadSchema, payload, 'LSP_WORKSPACE_SYMBOLS');
        const symbols = await lsp.workspaceSymbol(
          validated.query,
          validated.rootPath ?? ''
        );
        return {
          success: true,
          data: symbols
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LSP_WORKSPACE_SYMBOLS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Diagnostics
  ipcMain.handle(
    IPC_CHANNELS.LSP_DIAGNOSTICS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LspFilePayloadSchema, payload, 'LSP_DIAGNOSTICS');
        const diagnostics = await lsp.getDiagnostics(validated.filePath);
        return {
          success: true,
          data: diagnostics
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LSP_DIAGNOSTICS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Check if LSP is available for a file
  ipcMain.handle(
    IPC_CHANNELS.LSP_IS_AVAILABLE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LspFilePayloadSchema, payload, 'LSP_IS_AVAILABLE');
        const available = lsp.isAvailableForFile(validated.filePath);
        return {
          success: true,
          data: { available }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LSP_IS_AVAILABLE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Shutdown all LSP clients
  ipcMain.handle(
    IPC_CHANNELS.LSP_SHUTDOWN,
    async (): Promise<IpcResponse> => {
      try {
        await lsp.shutdown();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LSP_SHUTDOWN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
