import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { stdin, stdout } from 'node:process';
import type { BrowserAttachExistingTabRequest } from '@contracts/types/browser';
import type { BrowserExtensionNativeRuntimeConfig } from './browser-extension-native-runtime';

const NATIVE_HOST_ERROR_LOG_NAME = 'native-host-error.log';
const NATIVE_HOST_ERROR_LOG_MAX_BYTES = 64 * 1024;

interface BrowserExtensionAttachTabMessage {
  type: 'attach_tab';
  tab: BrowserAttachExistingTabRequest;
}

interface BrowserExtensionTabInventoryMessage {
  type: 'tab_inventory';
  tabs: BrowserAttachExistingTabRequest[];
}

interface BrowserExtensionPollCommandMessage {
  type: 'poll_command';
  timeoutMs?: number;
}

interface BrowserExtensionCommandResultMessage {
  type: 'command_result';
  commandId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface BrowserExtensionCommandReceivedMessage {
  type: 'command_received';
  commandId: string;
}

type BrowserExtensionNativeMessage =
  | BrowserExtensionAttachTabMessage
  | BrowserExtensionTabInventoryMessage
  | BrowserExtensionPollCommandMessage
  | BrowserExtensionCommandResultMessage
  | BrowserExtensionCommandReceivedMessage;

// The socket RPC timeout must OUTLIVE every downstream hop or a reply carrying
// a freshly dequeued command is abandoned mid-flight and the command silently
// dropped. Ladder (poll window 10s): coordinator holds ≤10s → worker relay
// waits window+10s=20s → native host must wait ≥25s → the extension's poll
// watchdog sits above all of it. Non-poll messages keep the short budget.
const NATIVE_RPC_TIMEOUT_MS = 15_000;
const NATIVE_POLL_RPC_TIMEOUT_BUFFER_MS = 15_000;

interface ExtensionRpcSendInput {
  socketPath: string;
  method: string;
  extensionToken: string;
  extensionOrigin?: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}

export interface HandleBrowserExtensionNativeMessageInput {
  message: unknown;
  extensionOrigin?: string;
  runtimeConfig: BrowserExtensionNativeRuntimeConfig;
  send?: (input: ExtensionRpcSendInput) => Promise<unknown>;
}

export interface AppendNativeHostErrorLogInput {
  configPath: string;
  message: string;
  now?: () => number;
  maxBytes?: number;
}

export function createNativeMessageFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function parseNativeMessageFrame(frame: Buffer): unknown {
  if (frame.length < 4) {
    throw new Error('native_message_frame_too_short');
  }
  const length = frame.readUInt32LE(0);
  if (frame.length - 4 < length) {
    throw new Error('native_message_frame_incomplete');
  }
  return JSON.parse(frame.subarray(4, 4 + length).toString('utf-8'));
}

export async function handleBrowserExtensionNativeMessage(
  input: HandleBrowserExtensionNativeMessageInput,
): Promise<Record<string, unknown>> {
  const message = parseBrowserExtensionNativeMessage(input.message);
  const send = input.send ?? sendExtensionRpc;
  switch (message.type) {
    case 'attach_tab': {
      const result = await send(toAttachTabRpcInput({
        tab: message.tab,
        extensionOrigin: input.extensionOrigin,
        runtimeConfig: input.runtimeConfig,
      }));
      return {
        ok: true,
        ackType: 'attach_tab',
        result,
      };
    }
    case 'tab_inventory': {
      const results = [];
      for (const tab of message.tabs) {
        results.push(await send(toAttachTabRpcInput({
          tab,
          extensionOrigin: input.extensionOrigin,
          runtimeConfig: input.runtimeConfig,
        })));
      }
      return {
        ok: true,
        ackType: 'tab_inventory',
        result: {
          attached: results.length,
          results,
        },
      };
    }
    case 'poll_command': {
      const pollWindowMs = message.timeoutMs ?? 10_000;
      const result = await send({
        ...toBaseRpcInput({
          extensionOrigin: input.extensionOrigin,
          runtimeConfig: input.runtimeConfig,
        }),
        method: 'browser.extension_poll_command',
        payload: message.timeoutMs === undefined ? {} : { timeoutMs: message.timeoutMs },
        timeoutMs: pollWindowMs + NATIVE_POLL_RPC_TIMEOUT_BUFFER_MS,
      });
      return {
        type: 'browser_command',
        command: result ?? null,
      };
    }
    case 'command_received': {
      // Fire-and-forget. Awaiting this RPC inside the serialized frame chain
      // let a slow/stalled coordinator hold the receipt ack for its full RPC
      // timeout, head-of-line blocking the command result (and next poll)
      // queued behind it — converting fast successful commands into
      // receipt_missing. A receipt lost here degrades to exactly that same
      // receipt_missing verdict, so failures are safe to swallow.
      void send({
        ...toBaseRpcInput({
          extensionOrigin: input.extensionOrigin,
          runtimeConfig: input.runtimeConfig,
        }),
        method: 'browser.extension_command_received',
        payload: { commandId: message.commandId },
      }).catch(() => undefined);
      return {
        ok: true,
        ackType: 'command_received',
        commandId: message.commandId,
      };
    }
    case 'command_result': {
      const result = await send({
        ...toBaseRpcInput({
          extensionOrigin: input.extensionOrigin,
          runtimeConfig: input.runtimeConfig,
        }),
        method: 'browser.extension_command_result',
        payload: commandResultPayload(message),
      });
      return {
        ok: true,
        ackType: 'command_result',
        commandId: message.commandId,
        result,
      };
    }
  }
}

export async function runBrowserExtensionNativeHost(): Promise<void> {
  const configPath = process.env['AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG'];
  if (!configPath) {
    stdout.write(createNativeMessageFrame({
      ok: false,
      error: 'missing_native_config_path',
    }));
    return;
  }

  let runtimeConfig: BrowserExtensionNativeRuntimeConfig;
  try {
    runtimeConfig = JSON.parse(
      fs.readFileSync(configPath, 'utf-8'),
    ) as BrowserExtensionNativeRuntimeConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendNativeHostErrorLog({
      configPath,
      message: `fatal init: ${message}`,
    });
    stdout.write(createNativeMessageFrame({
      ok: false,
      error: 'unreadable_native_config',
    }));
    return;
  }
  await runNativeMessageLoop({
    runtimeConfig,
    configPath,
    extensionOrigin: process.argv[2],
    input: stdin,
    output: stdout,
  });
}

export function appendNativeHostErrorLog(input: AppendNativeHostErrorLogInput): void {
  const maxBytes = Math.max(1, input.maxBytes ?? NATIVE_HOST_ERROR_LOG_MAX_BYTES);
  const logPath = path.join(path.dirname(input.configPath), NATIVE_HOST_ERROR_LOG_NAME);
  const timestamp = new Date(input.now?.() ?? Date.now()).toISOString();
  const safeMessage = input.message.replace(/[\r\n]+/g, ' ');
  const line = `[${timestamp}] ${safeMessage}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath) : Buffer.alloc(0);
    const combined = Buffer.concat([existing, Buffer.from(line, 'utf-8')]);
    const capped = combined.length <= maxBytes
      ? combined
      : combined.subarray(combined.length - maxBytes);
    fs.writeFileSync(logPath, capped, { mode: 0o600 });
    chmodIfSupported(logPath, 0o600);
  } catch {
    // Native-host diagnostics must never prevent Chrome from receiving a reply.
  }
}

function parseBrowserExtensionNativeMessage(
  value: unknown,
): BrowserExtensionNativeMessage {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid_browser_extension_message');
  }
  const message = value as Record<string, unknown>;
  if (message['type'] === 'attach_tab' && isRecord(message['tab'])) {
    return {
      type: 'attach_tab',
      tab: message['tab'] as unknown as BrowserAttachExistingTabRequest,
    };
  }
  if (message['type'] === 'tab_inventory' && Array.isArray(message['tabs'])) {
    return {
      type: 'tab_inventory',
      tabs: message['tabs']
        .filter(isRecord)
        .map((tab) => tab as unknown as BrowserAttachExistingTabRequest),
    };
  }
  if (message['type'] === 'poll_command') {
    const timeoutMs = message['timeoutMs'];
    if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
      throw new Error('invalid_browser_extension_message');
    }
    return {
      type: 'poll_command',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (
    message['type'] === 'command_received'
    && typeof message['commandId'] === 'string'
    && message['commandId']
  ) {
    return {
      type: 'command_received',
      commandId: message['commandId'],
    };
  }
  if (
    message['type'] === 'command_result'
    && typeof message['commandId'] === 'string'
    && typeof message['ok'] === 'boolean'
  ) {
    return {
      type: 'command_result',
      commandId: message['commandId'],
      ok: message['ok'],
      ...(Object.prototype.hasOwnProperty.call(message, 'result')
        ? { result: message['result'] }
        : {}),
      ...(typeof message['error'] === 'string' && message['error']
        ? { error: message['error'] }
        : {}),
    };
  }
  throw new Error('unsupported_browser_extension_message');
}

function runNativeMessageLoop(options: {
  runtimeConfig: BrowserExtensionNativeRuntimeConfig;
  configPath?: string;
  extensionOrigin?: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let pending = Promise.resolve();
    let loggedTransportFailure = false;

    options.input.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        const frameLength = length + 4;
        if (buffer.length < frameLength) {
          return;
        }
        const frame = buffer.subarray(0, frameLength);
        buffer = buffer.subarray(frameLength);
        pending = pending.then(async () => {
          // Parsed before the try so the error reply can carry the frame
          // type: the extension must be able to tell a failed poll (retry
          // the poll) from a failed result/receipt forward (must NOT clear
          // the in-flight poll while a command is still executing).
          let frameType: string | undefined;
          try {
            const message = parseNativeMessageFrame(frame);
            if (message && typeof message === 'object') {
              const type = (message as Record<string, unknown>)['type'];
              frameType = typeof type === 'string' ? type : undefined;
            }
            const response = await handleBrowserExtensionNativeMessage({
              message,
              extensionOrigin: options.extensionOrigin,
              runtimeConfig: options.runtimeConfig,
            });
            options.output.write(createNativeMessageFrame(response));
          } catch (error) {
            if (!loggedTransportFailure && options.configPath && isNativeHostTransportStartupError(error)) {
              loggedTransportFailure = true;
              appendNativeHostErrorLog({
                configPath: options.configPath,
                message: `socket connect failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
            options.output.write(createNativeMessageFrame({
              ok: false,
              ...(frameType ? { ackType: frameType } : {}),
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        });
      }
    });
    options.input.on('error', reject);
    options.input.on('end', () => {
      pending
        .then(() =>
          // Chrome closed the native messaging port (browser quit, extension
          // reloaded, or service worker replaced). Tell the gateway so health
          // and error messages can report a real disconnect instead of
          // inferring one from silence. Best-effort by design.
          sendBrowserExtensionDisconnected({
            runtimeConfig: options.runtimeConfig,
            extensionOrigin: options.extensionOrigin,
            reason: 'native_host_stdin_eof',
          }))
        .then(() => resolve(), reject);
    });
  });
}

export async function sendBrowserExtensionDisconnected(input: {
  runtimeConfig: BrowserExtensionNativeRuntimeConfig;
  extensionOrigin?: string;
  reason: string;
  send?: (rpc: ExtensionRpcSendInput) => Promise<unknown>;
}): Promise<void> {
  const send = input.send ?? sendExtensionRpc;
  try {
    await send({
      ...toBaseRpcInput({
        extensionOrigin: input.extensionOrigin,
        runtimeConfig: input.runtimeConfig,
      }),
      method: 'browser.extension_disconnected',
      payload: { reason: input.reason },
      timeoutMs: 3_000,
    });
  } catch {
    // The gateway may be gone too (app shutdown); the signal is best-effort.
  }
}

function readNativeMessageFrame(): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let expectedLength: number | null = null;

    stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      totalLength += chunk.length;
      const buffer = Buffer.concat(chunks, totalLength);
      if (expectedLength === null && buffer.length >= 4) {
        expectedLength = buffer.readUInt32LE(0);
      }
      if (expectedLength !== null && buffer.length >= expectedLength + 4) {
        resolve(buffer.subarray(0, expectedLength + 4));
      }
    });
    stdin.on('error', reject);
    stdin.on('end', () => {
      if (expectedLength !== null && totalLength >= expectedLength + 4) {
        return;
      }
      reject(new Error('native_message_frame_incomplete'));
    });
  });
}

function toAttachTabRpcInput(input: {
  tab: BrowserAttachExistingTabRequest;
  extensionOrigin?: string;
  runtimeConfig: BrowserExtensionNativeRuntimeConfig;
}): ExtensionRpcSendInput {
  return {
    ...toBaseRpcInput(input),
    method: 'browser.extension_attach_tab',
    payload: input.tab as unknown as Record<string, unknown>,
  };
}

function toBaseRpcInput(input: {
  extensionOrigin?: string;
  runtimeConfig: BrowserExtensionNativeRuntimeConfig;
}): Omit<ExtensionRpcSendInput, 'method' | 'payload'> {
  return {
    socketPath: input.runtimeConfig.socketPath,
    extensionToken: input.runtimeConfig.extensionToken,
    ...(input.extensionOrigin ? { extensionOrigin: input.extensionOrigin } : {}),
  };
}

function commandResultPayload(
  message: BrowserExtensionCommandResultMessage,
): Record<string, unknown> {
  return {
    commandId: message.commandId,
    ok: message.ok,
    ...(Object.prototype.hasOwnProperty.call(message, 'result')
      ? { result: message.result }
      : {}),
    ...(message.error ? { error: message.error } : {}),
  };
}

function sendExtensionRpc(input: ExtensionRpcSendInput): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = net.connect(input.socketPath);
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Browser Gateway extension RPC request timed out'));
    }, input.timeoutMs ?? NATIVE_RPC_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: input.method,
        params: {
          extensionToken: input.extensionToken,
          ...(input.extensionOrigin ? { extensionOrigin: input.extensionOrigin } : {}),
          payload: input.payload,
        },
      })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      clearTimeout(timeout);
      socket.end();
      const response = JSON.parse(buffer.slice(0, newline)) as {
        result?: unknown;
        error?: { message?: string };
      };
      if (response.error) {
        reject(new Error(response.error.message ?? 'Browser Gateway extension RPC failed'));
        return;
      }
      resolve(response.result);
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function isNativeHostTransportStartupError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ECONNRESET';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function chmodIfSupported(targetPath: string, mode: number): void {
  if (process.platform === 'win32') {
    return;
  }
  fs.chmodSync(targetPath, mode);
}

// No auto-run here. The aio-mcp SEA dispatcher is the only entrypoint —
// it imports `runBrowserExtensionNativeHost` and calls it under the
// `native-host` subcommand. See the matching comment in
// browser-mcp-stdio-server.ts for why a `require.main === module` guard
// would mis-fire from inside the dispatcher's esbuild bundle.
