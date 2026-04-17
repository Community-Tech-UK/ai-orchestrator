import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanForBarrelImports } = require('../verify-package-exports.js') as {
  scanForBarrelImports: (
    files: Array<{ path: string; content: string }>,
  ) => Array<{ path: string; pattern: string; line: number }>;
};

describe('scanForBarrelImports', () => {
  it('flags bare @contracts imports', () => {
    const offenders = scanForBarrelImports([
      {
        path: 'fake/foo.ts',
        content: "import { X } from '@contracts';\n",
      },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].path).toBe('fake/foo.ts');
    expect(offenders[0].pattern).toMatch(/@contracts['"]/);
  });

  it('flags bare @contracts/schemas imports', () => {
    const offenders = scanForBarrelImports([
      {
        path: 'fake/bar.ts',
        content: "import { Y } from '@contracts/schemas';\n",
      },
    ]);
    expect(offenders).toHaveLength(1);
  });

  it('flags bare @contracts/types imports', () => {
    const offenders = scanForBarrelImports([
      {
        path: 'fake/baz.ts',
        content: "import type { Z } from '@contracts/types';\n",
      },
    ]);
    expect(offenders).toHaveLength(1);
  });

  it('ALLOWS subpath imports', () => {
    const offenders = scanForBarrelImports([
      {
        path: 'fake/ok.ts',
        content: [
          "import { X } from '@contracts/schemas/session';",
          "import { Y } from '@contracts/channels/instance';",
          "import type { Z } from '@contracts/types/provider-runtime-events';",
          "export * from '@contracts/schemas/common';",
        ].join('\n'),
      },
    ]);
    expect(offenders).toHaveLength(0);
  });

  it('ALLOWS importing from the local channels index (used by codegen)', () => {
    const offenders = scanForBarrelImports([
      {
        path: 'scripts/generate-preload-channels.js',
        content: "const { IPC_CHANNELS } = require('@contracts/channels/index');",
      },
    ]);
    expect(offenders).toHaveLength(0);
  });

  it('reports multiple offenders in one file', () => {
    const offenders = scanForBarrelImports([
      {
        path: 'fake/multi.ts',
        content: [
          "import { A } from '@contracts';",
          "import { B } from '@contracts/schemas';",
        ].join('\n'),
      },
    ]);
    expect(offenders).toHaveLength(2);
  });
});
