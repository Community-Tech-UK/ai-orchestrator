import type {
  DesktopAccessibilitySnapshotRequest,
  DesktopAccessibilitySnapshotResult,
  DesktopAppDescriptor,
  DesktopClickRequest,
  DesktopDragRequest,
  DesktopHotkeyRequest,
  DesktopScrollRequest,
  DesktopTypeTextRequest,
} from '../../../shared/types/desktop-gateway.types';

export const DESKTOP_HELPER_PROTOCOL_VERSION = '1.0.0';
export const DESKTOP_HELPER_MAX_LINE_BYTES = 1024 * 1024;

export type DesktopHelperCommandName =
  | 'health'
  | 'listApps'
  | 'accessibilitySnapshot'
  | 'click'
  | 'typeText'
  | 'hotkey'
  | 'scroll'
  | 'drag';

export type DesktopHelperMode = 'bundled' | 'unavailable';
export type DesktopHelperIssue =
  | 'helper_missing'
  | 'version_mismatch'
  | 'helper_failed';

export interface DesktopHelperHealth {
  version: string;
  screenRecording: boolean;
  accessibility: boolean;
  input: boolean;
  setupActions: string[];
  mode?: DesktopHelperMode;
  degraded?: boolean;
  issue?: DesktopHelperIssue;
}

export interface DesktopHelperClient {
  health(): Promise<DesktopHelperHealth>;
  listApps(): Promise<DesktopAppDescriptor[]>;
  accessibilitySnapshot(
    request: DesktopAccessibilitySnapshotRequest,
  ): Promise<DesktopAccessibilitySnapshotResult>;
  click(request: DesktopClickRequest): Promise<void>;
  typeText(request: DesktopTypeTextRequest): Promise<void>;
  hotkey(request: DesktopHotkeyRequest): Promise<void>;
  scroll(request: DesktopScrollRequest): Promise<void>;
  drag(request: DesktopDragRequest): Promise<void>;
}

interface DesktopHelperResponse {
  protocolVersion: string;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code?: unknown;
  };
}

export class DesktopHelperProtocolError extends Error {
  constructor(
    public readonly code:
      | 'helper_protocol_invalid'
      | 'helper_request_mismatch'
      | 'helper_version_mismatch',
  ) {
    super(code);
    this.name = 'DesktopHelperProtocolError';
  }
}

export class DesktopHelperResponseError extends Error {
  constructor(public readonly helperCode: string) {
    super('desktop_helper_command_failed');
    this.name = 'DesktopHelperResponseError';
  }
}

export function serializeDesktopHelperRequest(
  id: string,
  command: DesktopHelperCommandName,
  payload: Record<string, unknown>,
): string {
  if (!id || id.length > 128 || /[\r\n]/u.test(id)) {
    throw new DesktopHelperProtocolError('helper_protocol_invalid');
  }
  const line = `${JSON.stringify({
    protocolVersion: DESKTOP_HELPER_PROTOCOL_VERSION,
    id,
    command,
    payload,
  })}\n`;
  if (Buffer.byteLength(line, 'utf8') > DESKTOP_HELPER_MAX_LINE_BYTES) {
    throw new DesktopHelperProtocolError('helper_protocol_invalid');
  }
  return line;
}

export function parseDesktopHelperResponse<T>(stdout: string, expectedId: string): T {
  if (Buffer.byteLength(stdout, 'utf8') > DESKTOP_HELPER_MAX_LINE_BYTES) {
    throw new DesktopHelperProtocolError('helper_protocol_invalid');
  }
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new DesktopHelperProtocolError('helper_protocol_invalid');
  }
  let parsed: DesktopHelperResponse;
  try {
    parsed = JSON.parse(lines[0]) as DesktopHelperResponse;
  } catch {
    throw new DesktopHelperProtocolError('helper_protocol_invalid');
  }
  if (!parsed || typeof parsed !== 'object'
    || typeof parsed.id !== 'string'
    || typeof parsed.protocolVersion !== 'string'
    || typeof parsed.ok !== 'boolean') {
    throw new DesktopHelperProtocolError('helper_protocol_invalid');
  }
  if (parsed.protocolVersion !== DESKTOP_HELPER_PROTOCOL_VERSION) {
    throw new DesktopHelperProtocolError('helper_version_mismatch');
  }
  if (parsed.id !== expectedId) {
    throw new DesktopHelperProtocolError('helper_request_mismatch');
  }
  if (!parsed.ok) {
    const code = parsed.error?.code;
    throw new DesktopHelperResponseError(typeof code === 'string' ? code : 'helper_failed');
  }
  return parsed.result as T;
}
