/**
 * LLM IPC Handlers
 * Handles LLM service operations including streaming responses
 */

import { ipcMain, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import { getLLMService, StreamChunk } from '../rlm/llm-service';
import { getTokenCounter } from '../rlm/token-counter';
import {
  validateIpcPayload,
  LLMSummarizePayloadSchema,
  LLMSubQueryPayloadSchema,
  LLMCancelStreamPayloadSchema,
  LLMCountTokensPayloadSchema,
  LLMTruncateTokensPayloadSchema,
  LLMSetConfigPayloadSchema,
} from '@contracts/schemas';

/**
 * Get the main window for sending events
 */
function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

/**
 * Send a streaming chunk to the renderer
 */
function sendStreamChunk(chunk: StreamChunk): void {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.LLM_STREAM_CHUNK, chunk);
  }
}

/**
 * Register all LLM-related IPC handlers
 */
export function registerLLMHandlers(): void {
  const llm = getLLMService();
  const tokenCounter = getTokenCounter();

  // ============================================
  // Non-streaming handlers
  // ============================================

  // Summarize content (non-streaming)
  ipcMain.handle(
    IPC_CHANNELS.LLM_SUMMARIZE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LLMSummarizePayloadSchema, payload, 'LLM_SUMMARIZE');
        const targetTokens: number = validated.targetTokens ?? 500;
        const summary = await llm.summarize({
          requestId: validated.requestId,
          content: validated.content,
          targetTokens,
          preserveKeyPoints: validated.preserveKeyPoints,
        });
        return {
          success: true,
          data: {
            requestId: validated.requestId,
            summary,
            originalTokens: llm.countTokens(validated.content),
            summaryTokens: llm.countTokens(summary),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LLM_SUMMARIZE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Sub-query (non-streaming)
  ipcMain.handle(
    IPC_CHANNELS.LLM_SUBQUERY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LLMSubQueryPayloadSchema, payload, 'LLM_SUBQUERY');
        const context: string = validated.context ?? '';
        const depth: number = validated.depth ?? 0;
        const response = await llm.subQuery({
          requestId: validated.requestId,
          prompt: validated.prompt,
          context,
          depth,
        });
        return {
          success: true,
          data: {
            requestId: validated.requestId,
            response,
            depth: validated.depth,
            tokens: {
              input: llm.countTokens((validated.context ?? '') + validated.prompt),
              output: llm.countTokens(response),
            },
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LLM_SUBQUERY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Streaming handlers
  // ============================================

  // Summarize with streaming
  // This initiates the stream and returns immediately.
  // Chunks are sent via IPC events to the renderer.
  ipcMain.handle(
    IPC_CHANNELS.LLM_SUMMARIZE_STREAM,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LLMSummarizePayloadSchema, payload, 'LLM_SUMMARIZE_STREAM');
        const streamTargetTokens: number = validated.targetTokens ?? 500;
        // Start streaming in background
        const streamGenerator = llm.summarizeStreaming({
          requestId: validated.requestId,
          content: validated.content,
          targetTokens: streamTargetTokens,
          preserveKeyPoints: validated.preserveKeyPoints,
        });

        // Process stream and send chunks to renderer
        processStreamInBackground(streamGenerator, validated.requestId);

        return {
          success: true,
          data: {
            requestId: validated.requestId,
            streaming: true,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LLM_SUMMARIZE_STREAM_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Sub-query with streaming
  ipcMain.handle(
    IPC_CHANNELS.LLM_SUBQUERY_STREAM,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LLMSubQueryPayloadSchema, payload, 'LLM_SUBQUERY_STREAM');
        const streamContext: string = validated.context ?? '';
        const streamDepth: number = validated.depth ?? 0;
        // Start streaming in background
        const streamGenerator = llm.subQueryStreaming({
          requestId: validated.requestId,
          prompt: validated.prompt,
          context: streamContext,
          depth: streamDepth,
        });

        // Process stream and send chunks to renderer
        processStreamInBackground(streamGenerator, validated.requestId);

        return {
          success: true,
          data: {
            requestId: validated.requestId,
            streaming: true,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LLM_SUBQUERY_STREAM_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Cancel an active stream
  ipcMain.handle(
    IPC_CHANNELS.LLM_CANCEL_STREAM,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LLMCancelStreamPayloadSchema, payload, 'LLM_CANCEL_STREAM');
        const cancelled = llm.cancelStream(validated.requestId);
        return {
          success: true,
          data: { cancelled, requestId: validated.requestId },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LLM_CANCEL_STREAM_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Token counting handlers
  // ============================================

  // Count tokens in text
  ipcMain.handle(
    IPC_CHANNELS.LLM_COUNT_TOKENS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LLMCountTokensPayloadSchema, payload, 'LLM_COUNT_TOKENS');
        const count = tokenCounter.countTokens(validated.text, validated.model);
        return {
          success: true,
          data: { count, model: validated.model },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LLM_COUNT_TOKENS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Truncate text to token limit
  ipcMain.handle(
    IPC_CHANNELS.LLM_TRUNCATE_TOKENS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LLMTruncateTokensPayloadSchema, payload, 'LLM_TRUNCATE_TOKENS');
        const truncated = tokenCounter.truncateToTokens(
          validated.text,
          validated.maxTokens,
          validated.model
        );
        return {
          success: true,
          data: {
            truncated,
            originalTokens: tokenCounter.countTokens(validated.text, validated.model),
            truncatedTokens: tokenCounter.countTokens(truncated, validated.model),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LLM_TRUNCATE_TOKENS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Configuration handlers
  // ============================================

  // Get LLM configuration
  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_CONFIG,
    async (): Promise<IpcResponse> => {
      try {
        const config = llm.getConfig();
        // Mask API keys for security
        const safeConfig = {
          ...config,
          anthropicApiKey: config.anthropicApiKey ? '***' : undefined,
          openaiApiKey: config.openaiApiKey ? '***' : undefined,
        };
        return { success: true, data: safeConfig };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LLM_GET_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Set LLM configuration
  ipcMain.handle(
    IPC_CHANNELS.LLM_SET_CONFIG,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(LLMSetConfigPayloadSchema, payload, 'LLM_SET_CONFIG');
        llm.configure(validated);
        const config = llm.getConfig();
        // Mask API keys for security
        const safeConfig = {
          ...config,
          anthropicApiKey: config.anthropicApiKey ? '***' : undefined,
          openaiApiKey: config.openaiApiKey ? '***' : undefined,
        };
        return { success: true, data: safeConfig };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LLM_SET_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get provider status
  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_STATUS,
    async (): Promise<IpcResponse> => {
      try {
        const status = llm.getProviderStatus();
        const available = await llm.isAvailable();
        return {
          success: true,
          data: {
            providers: status,
            available,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LLM_GET_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );
}

/**
 * Process a stream generator in the background and send chunks to renderer
 */
async function processStreamInBackground(
  generator: AsyncGenerator<StreamChunk, string, unknown>,
  requestId: string
): Promise<void> {
  try {
    for await (const chunk of generator) {
      sendStreamChunk(chunk);
    }
  } catch (error) {
    // Send error chunk if stream fails
    sendStreamChunk({
      requestId,
      chunk: '',
      done: true,
      error: (error as Error).message,
    });
  }
}
