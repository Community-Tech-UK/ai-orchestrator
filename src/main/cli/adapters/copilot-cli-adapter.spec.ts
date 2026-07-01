import { describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: loggerMock.warn,
  }),
}));

vi.mock('../../security/env-filter', () => ({
  getSafeEnvForTrustedProcess: () => ({ ...process.env }),
}));

vi.mock('../../context/output-persistence', () => ({
  getOutputPersistenceManager: () => ({
    maybeExternalize: (_name: string, content: string) => Promise.resolve(content),
  }),
}));

import { CopilotCliAdapter } from './copilot-cli-adapter';

describe('CopilotCliAdapter stream JSON parsing', () => {
  it('recovers assistant content from a repaired stream-json line', () => {
    const adapter = new CopilotCliAdapter();

    const response = adapter.parseOutput('{"type":"assistant.message","data":{"content":"repaired"},}\n');

    expect(response.content).toBe('repaired');
  });

  it('logs malformed JSON-looking stream lines and continues parsing later events', () => {
    loggerMock.warn.mockClear();
    const adapter = new CopilotCliAdapter();
    const raw = [
      '{"type":"assistant.message","data":',
      '{"type":"assistant.message","data":{"content":"recovered"},}',
    ].join('\n');

    const response = adapter.parseOutput(raw);

    expect(response.content).toBe('recovered');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Failed to parse Copilot stream-json line',
      expect.objectContaining({ linePreview: '{"type":"assistant.message","data":' }),
    );
  });
});
