export interface CodexAppServerErrorDetails {
  additionalDetails?: string;
  codexErrorInfo?: string;
  message: string;
  willRetry?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function serializeCodexErrorInfo(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value.trim() || undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function extractCodexAppServerError(
  params: Record<string, unknown>,
): CodexAppServerErrorDetails {
  const nestedError = isRecord(params['error']) ? params['error'] : undefined;
  const message = readStringField(params, 'message')
    ?? readStringField(nestedError, 'message')
    ?? 'Unknown error from codex app-server';
  const additionalDetails = readStringField(params, 'additionalDetails', 'additional_details')
    ?? readStringField(nestedError, 'additionalDetails', 'additional_details');
  const codexErrorInfo = serializeCodexErrorInfo(
    params['codex_error_info']
      ?? params['codexErrorInfo']
      ?? nestedError?.['codex_error_info']
      ?? nestedError?.['codexErrorInfo'],
  );
  const willRetry = typeof params['willRetry'] === 'boolean' ? params['willRetry'] : undefined;

  return {
    additionalDetails,
    codexErrorInfo,
    message,
    willRetry,
  };
}

export function formatCodexAppServerError(details: CodexAppServerErrorDetails): string {
  const parts = [details.message];
  if (details.additionalDetails && details.additionalDetails !== details.message) {
    parts.push(details.additionalDetails);
  }
  if (details.codexErrorInfo) {
    parts.push(`[codex_error_info: ${details.codexErrorInfo}]`);
  }
  return parts.join(' - ');
}
