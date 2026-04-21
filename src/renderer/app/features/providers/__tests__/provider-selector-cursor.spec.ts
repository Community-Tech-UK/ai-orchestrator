/**
 * ProviderSelectorComponent — Cursor CLI option tests
 *
 * Covers:
 * - allProviders includes a `cursor` entry
 * - The cursor entry has a human-friendly name, a color, and an icon key
 * - The component's ProviderType union accepts 'cursor' as a value
 *
 * NOTE: The plan used `value`/`label`/`iconSvg` field names, but the real
 * component schema uses `id`/`name`/`icon` (see `ProviderOption` interface).
 * Tests are adapted to match the real schema.
 */

import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ProviderSelectorComponent, type ProviderType } from '../provider-selector.component';

describe('ProviderSelectorComponent — cursor', () => {
  it('allProviders includes a cursor option', () => {
    const fixture = TestBed.createComponent(ProviderSelectorComponent);
    const instance = fixture.componentInstance as unknown as {
      allProviders: { id: string; name: string; color: string; icon: string }[];
    };
    expect(instance.allProviders.map(p => p.id)).toContain('cursor');
  });

  it('cursor option has name Cursor, a color, and an icon key', () => {
    const fixture = TestBed.createComponent(ProviderSelectorComponent);
    const instance = fixture.componentInstance as unknown as {
      allProviders: { id: string; name: string; color: string; icon: string; description: string }[];
    };
    const opt = instance.allProviders.find(p => p.id === 'cursor');
    expect(opt).toBeDefined();
    expect(opt?.name).toBe('Cursor');
    expect(opt?.color).toBeTruthy();
    expect(opt?.icon).toBeTruthy();
    expect(opt?.description).toBeTruthy();
  });

  it('ProviderType union accepts cursor as a value', () => {
    const value: ProviderType = 'cursor';
    expect(value).toBe('cursor');
  });
});
