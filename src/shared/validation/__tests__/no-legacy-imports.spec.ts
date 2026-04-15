import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Guard test: ensures no production code imports from the deprecated
 * ipc-schemas.ts shim. All imports should use '@contracts/schemas'.
 */
describe('Legacy IPC schema shim guard', () => {
  const projectRoot = join(__dirname, '..', '..', '..', '..');

  it('should have zero production imports of the deprecated ipc-schemas shim', () => {
    // Search for imports of ipc-schemas in production TypeScript files,
    // excluding the shim itself, spec files, and node_modules.
    let result = '';
    try {
      result = execFileSync(
        'grep',
        ['-r', 'from.*shared/validation/ipc-schemas', '--include=*.ts', '-l',
         join(projectRoot, 'src'), join(projectRoot, 'packages')],
        { encoding: 'utf8' },
      );
    } catch {
      // grep returns exit code 1 when no matches — that's the desired result
      result = '';
    }

    const files = result
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.includes('node_modules'))
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => !f.includes('ipc-schemas.ts')); // Exclude the shim itself

    expect(files).toEqual([]);
  });

  it('should export all schemas from @contracts/schemas', async () => {
    // Verify that the contracts package exports validateIpcPayload and key schemas
    const contracts = await import('@contracts/schemas');

    expect(contracts.validateIpcPayload).toBeDefined();
    expect(contracts.InstanceCreatePayloadSchema).toBeDefined();
    expect(contracts.SessionForkPayloadSchema).toBeDefined();
    expect(contracts.ProviderStatusPayloadSchema).toBeDefined();
    expect(contracts.DebateStartPayloadSchema).toBeDefined();
    expect(contracts.SettingsGetPayloadSchema).toBeDefined();
  });
});
