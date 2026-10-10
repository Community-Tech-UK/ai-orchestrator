/** Native response state is adopted synchronously, before the request promise resolves. */
export interface AcpSessionResponseRequest {
  method: string;
  configOption?: { configId: string; value: string };
  /** Resume identity belongs to the request, not an optional response field. */
  loadSessionId?: string;
}

interface AcpSessionConfigResponseState {
  sessionId?: string;
  configOptions: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Opening responses validate identity; config acknowledgments retain authoritative options. */
export function reduceAcpSessionConfigResponse(
  currentOptions: unknown,
  request: AcpSessionResponseRequest,
  result: unknown,
): AcpSessionConfigResponseState {
  const response = isRecord(result) ? result : undefined;
  if (request.method === 'session/new' || request.method === 'session/load') {
    const sessionId = request.method === 'session/load' ? request.loadSessionId
      : typeof response?.['sessionId'] === 'string' ? response['sessionId'] : undefined;
    if (!sessionId?.trim()) throw new Error(`ACP ${request.method} response requires a sessionId.`);
    return { sessionId, configOptions: response?.['configOptions'] };
  }
  if (request.configOption) {
    if (Array.isArray(response?.['configOptions'])) return { configOptions: response['configOptions'] };
    if (Array.isArray(currentOptions)) {
      const { configId, value } = request.configOption;
      return { configOptions: currentOptions.map((option: unknown) =>
        isRecord(option) && option['id'] === configId ? { ...option, currentValue: value } : option) };
    }
  }
  return { configOptions: currentOptions };
}
