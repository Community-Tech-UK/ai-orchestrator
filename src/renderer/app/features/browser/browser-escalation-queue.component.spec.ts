import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserEscalationQueueComponent } from './browser-escalation-queue.component';
import { BrowserUnattendedStore } from './browser-unattended.store';
import type { BrowserEscalation } from './browser-unattended.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './browser-escalation-queue.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './browser-escalation-queue.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('browser-escalation-queue.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('browser-escalation-queue.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const escalation: BrowserEscalation = {
  id: 'escalation-1',
  profileId: 'profile-1',
  campaignId: 'campaign-1',
  kind: 'captcha',
  reason: 'Captcha challenge encountered',
  url: 'https://example.com/verify',
  status: 'pending',
  createdAt: Date.now() - 5 * 60_000,
};

function inputEvent(value: string): Event {
  return { target: { value } } as unknown as Event;
}

describe('BrowserEscalationQueueComponent', () => {
  let fixture: ComponentFixture<BrowserEscalationQueueComponent>;
  let store: {
    pendingEscalations: ReturnType<typeof vi.fn>;
    busy: ReturnType<typeof vi.fn>;
    errorMessage: ReturnType<typeof vi.fn>;
    refreshEscalations: ReturnType<typeof vi.fn>;
    resolveEscalation: ReturnType<typeof vi.fn>;
    skipEscalation: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    store = {
      pendingEscalations: vi.fn(() => [escalation]),
      busy: vi.fn(() => false),
      errorMessage: vi.fn(() => null),
      refreshEscalations: vi.fn().mockResolvedValue(undefined),
      resolveEscalation: vi.fn().mockResolvedValue(true),
      skipEscalation: vi.fn().mockResolvedValue(true),
    };

    await TestBed.configureTestingModule({
      imports: [BrowserEscalationQueueComponent],
      providers: [{ provide: BrowserUnattendedStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserEscalationQueueComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('refreshes escalations on init and renders the pending queue', () => {
    expect(store.refreshEscalations).toHaveBeenCalled();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('captcha');
    expect(text).toContain('Captcha challenge encountered');
    expect(text).toContain('https://example.com/verify');
  });

  it('resolves an escalation with an optional note', async () => {
    const component = fixture.componentInstance;
    component.onNoteInput('escalation-1', inputEvent('Solved manually'));

    await component.resolve('escalation-1');

    expect(store.resolveEscalation).toHaveBeenCalledWith('escalation-1', 'Solved manually');
  });

  it('skips an escalation without a note by passing undefined', async () => {
    const component = fixture.componentInstance;

    await component.skip('escalation-1');

    expect(store.skipEscalation).toHaveBeenCalledWith('escalation-1', undefined);
  });
});
