import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectVisibleErrorSites, presentationSources } from './visible-error-ratchet';

describe('raw provider error ratchet', () => {
  it('catches direct interpolation and error.message, including optional access', () => {
    expect(collectVisibleErrorSites('example.ts', 'notice.set(`Failed: ${error}`);')).toHaveLength(1);
    expect(collectVisibleErrorSites('example.ts', 'notice.set(error.message);')).toHaveLength(1);
    expect(collectVisibleErrorSites('example.ts', 'notice.set(response.error?.message);')).toHaveLength(1);
    expect(collectVisibleErrorSites('example.html', '<p>{{ error.message }}</p>')).toHaveLength(1);
    expect(collectVisibleErrorSites('example.ts', 'notice.set(error /* context */ . message);')).toHaveLength(1);
    expect(collectVisibleErrorSites('example.ts', 'notice.set(`${ /* context */ error}`);')).toHaveLength(1);
    expect(collectVisibleErrorSites('example.ts', String.raw`notice.set(error.\u006dessage);`)).toHaveLength(1);
  });

  it('permits diagnostic logging, the shared presenter and ordinary message content', () => {
    const source = 'logger.error(error.message); console.warn(`${error}`); notice.set(presentError(error).headline); const text = request.message;';
    expect(collectVisibleErrorSites('example.ts', source)).toEqual([]);
    expect(collectVisibleErrorSites('example.html', '<p>{{ errorPresentation().headline }}</p>')).toEqual([]);
  });

  it('checks main-process transcript content while permitting diagnostic fields and machine errors', () => {
    const source = 'const detail = error.message; const payload = { metadata: { errorPresentation: { rawDetail: error.message } } }; throw new Error(error.message);';
    expect(collectVisibleErrorSites('src/main/example.ts', source)).toEqual([]);
    expect(collectVisibleErrorSites('src/main/example.ts', 'const output = { content: error.message };')).toHaveLength(1);
    expect(collectVisibleErrorSites('src/main/example.ts', 'deps.emitSystemMessage(id, `Failed: ${error}`);')).toHaveLength(1);
    expect(collectVisibleErrorSites('src/main/example.ts', 'deps.emitSystemMessage(id, presented.headline, { rawDetail: error.message });')).toEqual([]);
  });

  it('does not allow new raw error sites above the existing baseline', () => {
    const baseline = {
      ...JSON.parse(readFileSync(resolve('scripts/visible-error-baseline.json'), 'utf8')) as Record<string, number>,
      ...JSON.parse(readFileSync(resolve('scripts/visible-main-error-baseline.json'), 'utf8')) as Record<string, number>,
    };
    const counts = new Map<string, number>();
    for (const [path, source] of presentationSources()) {
      for (const site of collectVisibleErrorSites(path, source)) counts.set(site.key, (counts.get(site.key) ?? 0) + 1);
    }
    const added = [...counts].filter(([key, count]) => count > (baseline[key] ?? 0));
    expect(added, 'Use presentError for visible copy; keep raw diagnostics under Details. Do not raise the baseline.').toEqual([]);
  }, 15_000); // This assertion parses both production trees; the default 5 s expired during the affected-spec run.
});
