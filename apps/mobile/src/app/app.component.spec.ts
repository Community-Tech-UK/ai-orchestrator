import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The approval sheet covers most of the screen, so when a decision failed the
 * connection pill explaining why sat hidden behind the scrim and the prompt just
 * appeared to do nothing. A rejected token now reports itself on the sheet.
 */
describe('AppComponent approval failure feedback', () => {
  const app = readFileSync(resolve('src/app/app.component.ts'), 'utf8');
  const sheet = readFileSync(
    resolve('src/app/features/approval/approval-sheet.component.ts'),
    'utf8',
  );

  it('surfaces a failed decision on the sheet instead of swallowing it', () => {
    expect(app).toContain('[error]="decideErrorFor(p)"');
    expect(app).toContain('this.decideError.set({');
    // The old behaviour: an empty catch that discarded the reason entirely.
    expect(app).not.toContain('/* the prompt stays if the call fails */');
  });

  it('keys the failure to its prompt so it cannot leak onto another one', () => {
    expect(app).toContain('failure?.promptId === prompt.id');
  });

  // Whether the sheet actually RENDERS that error for every prompt kind is not
  // provable by substring presence — that check passed while two of four branches
  // dropped it. approval-sheet.component.spec.ts asserts the placement instead.
  it('gives the sheet an error input to render', () => {
    expect(sheet).toContain('readonly error = input<string | null>(null);');
  });
});
