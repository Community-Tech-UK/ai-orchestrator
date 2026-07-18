import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findUnsafeHandlersInSource } = require('../verify-ipc-handler-contract.js') as {
  findUnsafeHandlersInSource: (file: string, source: string) => Array<{ line: number }>;
};

describe('verify-ipc-handler-contract', () => {
  it('flags raw direct handlers without a structured return contract', () => {
    const findings = findUnsafeHandlersInSource('raw.ts', `
      ipcMain.handle('raw:channel', async (_event, payload) => {
        return service.read(payload);
      });
    `);

    expect(findings).toHaveLength(1);
  });

  it('accepts validated handlers and explicit IpcResponse callbacks', () => {
    const findings = findUnsafeHandlersInSource('safe.ts', `
      ipcMain.handle('safe:validated', validatedHandler(
        'safe:validated',
        PayloadSchema,
        async () => ({ success: true }),
      ));
      ipcMain.handle(
        'safe:typed',
        async (): Promise<IpcResponse<{ value: number }>> => ({
          success: true,
          data: { value: 1 },
        }),
      );
    `);

    expect(findings).toEqual([]);
  });
});
