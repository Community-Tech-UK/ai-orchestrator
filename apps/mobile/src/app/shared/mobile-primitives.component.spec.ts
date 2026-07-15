import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mobileSessionRowAriaLabel,
  type MobileSessionRowView,
} from './mobile-session-row.component';
import { mobileSheetDismissLabel } from './mobile-sheet.component';

describe('mobile visual primitives', () => {
  it('gives a sheet scrim a specific dismissal label', () => {
    expect(mobileSheetDismissLabel('Provider')).toBe('Close Provider');
  });

  it('announces a session row by title and state', () => {
    const row: MobileSessionRowView = {
      id: 'session-1',
      title: 'Polish mobile UX',
      subtitle: 'Codex',
      statusLabel: 'working',
      tone: 'working',
      unread: false,
      live: true,
      lastActivity: 1,
    };

    expect(mobileSessionRowAriaLabel(row)).toBe('Open Polish mobile UX, working');
  });

  it('announces the selected approval scope', () => {
    const source = readFileSync(
      resolve('src/app/features/approval/approval-sheet.component.ts'),
      'utf8',
    );
    expect(source).toContain('[attr.data-scope]="scopeOption"');
    expect(source).toContain('[attr.aria-pressed]="scope() === scopeOption"');
  });

  it('uses the shared sheet and vector controls for model selection', () => {
    const source = readFileSync(resolve('src/app/shared/model-sheet.component.ts'), 'utf8');
    expect(source).toContain('<app-mobile-sheet label="Model picker"');
    expect(source).toContain('<app-mobile-icon name="check" />');
    expect(source).toContain('<app-mobile-icon name="close" />');
    expect(source).toContain('Reasoning');
    expect(source).toContain('chooseReasoning.emit');
  });

  it('uses a vector lock mark and labelled shared unlock action', () => {
    const source = readFileSync(
      resolve('src/app/features/lock/lock-screen.component.ts'),
      'utf8',
    );
    expect(source).toContain('<app-mobile-icon name="lock" />');
    expect(source).toContain('class="mobile-primary-button unlock-button"');
    expect(source).toContain('Unlock with {{ lock.biometryLabel() }}');
    expect(source).not.toContain('🔒');
  });
});
