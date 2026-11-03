import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/** Angular pins Vite exactly; only equal or newer patches in that minor retain its contract. */
function compatibleVitePatch(required: string, loaded: string): boolean {
  const version = /^(\d+)\.(\d+)\.(\d+)$/;
  const expected = version.exec(required);
  const actual = version.exec(loaded);
  return expected !== null && actual !== null && expected[1] === actual[1] && expected[2] === actual[2]
    && Number(actual[3]) >= Number(expected[3]);
}

describe('renderer dev-server linker toolchain', () => {
  it.each([
    ['8.3.0', '7.3.7', false],
    ['8.3.0', '8.4.0', false],
    ['8.3.3', '8.3.2', false],
    ['8.3.0', '8.3.5-beta', false],
    ['^8.3.0', '8.3.5', false],
    ['8.3.0', '8.3.0', true],
    ['8.3.0', '8.3.5', true],
  ] as const)('checks builder %s against installed %s', (required, loaded, compatible) => {
    expect(compatibleVitePatch(required, loaded)).toBe(compatible);
  });

  it('loads Vite compatible with Angular\'s linker hooks, including security patches', () => {
    const angularDevkit = createRequire(require.resolve('@angular-devkit/build-angular/package.json'));
    const angularBuildPath = angularDevkit.resolve('@angular/build/package.json');
    const angularBuild = createRequire(angularBuildPath);
    const builder = JSON.parse(readFileSync(angularBuildPath, 'utf8')) as { dependencies: Record<string, string> };
    const vite = JSON.parse(readFileSync(angularBuild.resolve('vite/package.json'), 'utf8')) as { version: string };
    const required = builder.dependencies['vite'];
    expect(required).toBeTypeOf('string');
    expect(compatibleVitePatch(required, vite.version),
      `Angular requires Vite ${required}, but loads ${vite.version}; an incompatible override bypasses its dependency linker.`).toBe(true);
  });
});
