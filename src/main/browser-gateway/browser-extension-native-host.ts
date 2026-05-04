import * as fs from 'node:fs';
import * as net from 'node:net';
import { stdin, stdout } from 'node:process';
import type {
  BrowserAttachExistingTabRequest,
} from '@contracts/types/browser';
import type {
  BrowserExtensionNativeRuntimeConfig,
} from './browser-extension-native-runtime';

interface BrowserExtensionAttachTabMessage {
  type: 'attach_tab';
  tab: BrowserAttachExistingTabRequest;
}

interface BrowserExtensionCommandTabReference {
  profileId: string;
  targetId: string;
  tabId: number;
  windowId: number;
}

interface BrowserExtensionPollCommandsMessage {
  type: 'poll_commands';
  tab: BrowserExtensionCommandTabReference;
}

interface BrowserExtensionCompleteCommandMessage {
  type: 'complete_command';
  commandId: string;
  status: 'succeeded' | 'failed';
  error?: string;
  tab: BrowserExtensionCommandTabReference & Partial<BrowserAttachExistingTabRequest>;
}

type BrowserExtensionNativeMessage =
  | BrowserExtensionAttachTabMessage
  | BrowserExtensionPollCommandsMessage
  | BrowserExtensionCompleteCommandMessage;

interface ExtensionRpcSendInput {
  socketPath: string;
  method: string;
  extensionToken: string;
  extensionOrigin?: string;
  payload: Record<string, unknown>;
}

export interface HandleBrowserExtensionNativeMessageInput {
  message: unknown;
  extensionOrigin?: string;
  runtimeConfig: BrowserExtensionNativeRuntimeConfig;
  send?: (input: ExtensionRpcSendInput) => Promise<unknown>;
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
  const result = await send(toRpcInput({
    message,
    extensionOrigin: input.extensionOrigin,
    runtimeConfig: input.runtimeConfig,
  }));
  return {
    ok: true,
    result,
  };
}

async function main(): Promise<void> {
  const configPath = process.env['AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG'];
  if (!configPath) {
    stdout.write(createNativeMessageFrame({
      ok: false,
      error: 'missing_native_config_path',
    }));
    return;
  }

  const runtimeConfig = JSON.parse(
    fs.readFileSync(configPath, 'utf-8'),
  ) as BrowserExtensionNativeRuntimeConfig;
  const frame = await readNativeMessageFrame();
  const response = await handleBrowserExtensionNativeMessage({
    message: parseNativeMessageFrame(frame),
    extensionOrigin: process.argv[2],
    runtimeConfig,
  });
  stdout.write(createNativeMessageFrame(response));
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
  if (message['type'] === 'poll_commands' && isRecord(message['tab'])) {
    return {
      type: 'poll_commands',
      tab: parseCommandTabReference(message['tab']),
    };
  }
  if (message['type'] === 'complete_command' && isRecord(message['tab'])) {
    const status = message['status'];
    if (status !== 'succeeded' && status !== 'failed') {
      throw new Error('unsupported_browser_extension_message');
    }
    return {
      type: 'complete_command',
      commandId: requireString(message['commandId'], 'commandId'),
      status,
      ...(typeof message['error'] === 'string' && message['error']
        ? { error: message['error'] }
        : {}),
      tab: parseCompleteCommandTab(message['tab']),
    };
  }
  throw new Error('unsupported_browser_extension_message');
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

function toRpcInput(input: {
  message: BrowserExtensionNativeMessage;
  extensionOrigin?: string;
  runtimeConfig: BrowserExtensionNativeRuntimeConfig;
}): ExtensionRpcSendInput {
  const base = {
    socketPath: input.runtimeConfig.socketPath,
    extensionToken: input.runtimeConfig.extensionToken,
    ...(input.extensionOrigin ? { extensionOrigin: input.extensionOrigin } : {}),
  };
  if (input.message.type === 'attach_tab') {
    return {
      ...base,
      method: 'browser.extension_attach_tab',
      payload: input.message.tab as unknown as Record<string, unknown>,
    };
  }
  if (input.message.type === 'poll_commands') {
    return {
      ...base,
      method: 'browser.extension_poll_commands',
      payload: input.message.tab as unknown as Record<string, unknown>,
    };
  }

  const tab = input.message.tab;
  const payload: Record<string, unknown> = {
    commandId: input.message.commandId,
    profileId: tab.profileId,
    targetId: tab.targetId,
    tabId: tab.tabId,
    windowId: tab.windowId,
    status: input.message.status,
    ...(input.message.error ? { error: input.message.error } : {}),
  };
  if (input.message.status === 'succeeded') {
    payload['tab'] = {
      tabId: tab.tabId,
      windowId: tab.windowId,
      url: tab.url,
      ...(tab.title ? { title: tab.title } : {}),
      ...(tab.text !== undefined ? { text: tab.text } : {}),
      ...(tab.screenshotBase64 !== undefined ? { screenshotBase64: tab.screenshotBase64 } : {}),
      ...(tab.capturedAt !== undefined ? { capturedAt: tab.capturedAt } : {}),
    };
  }
  return {
    ...base,
    method: 'browser.extension_complete_command',
    payload,
  };
}

function sendExtensionRpc(input: ExtensionRpcSendInput): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = net.connect(input.socketPath);
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Browser Gateway extension RPC request timed out'));
    }, 15_000);

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

function parseCommandTabReference(value: Record<string, unknown>): BrowserExtensionCommandTabReference {
  return {
    profileId: requireString(value['profileId'], 'profileId'),
    targetId: requireString(value['targetId'], 'targetId'),
    tabId: requireNumber(value['tabId'], 'tabId'),
    windowId: requireNumber(value['windowId'], 'windowId'),
  };
}

function parseCompleteCommandTab(
  value: Record<string, unknown>,
): BrowserExtensionCompleteCommandMessage['tab'] {
  const reference = parseCommandTabReference(value);
  return {
    ...reference,
    ...(typeof value['url'] === 'string' ? { url: value['url'] } : {}),
    ...(typeof value['title'] === 'string' ? { title: value['title'] } : {}),
    ...(typeof value['text'] === 'string' ? { text: value['text'] } : {}),
    ...(typeof value['screenshotBase64'] === 'string'
      ? { screenshotBase64: value['screenshotBase64'] }
      : {}),
    ...(typeof value['capturedAt'] === 'number' ? { capturedAt: value['capturedAt'] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`invalid_browser_extension_${name}`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`invalid_browser_extension_${name}`);
  }
  return value as number;
}

if (require.main === module) {
  void main().catch((error) => {
    stdout.write(createNativeMessageFrame({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}
