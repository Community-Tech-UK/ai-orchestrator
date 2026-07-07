import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserUnattendedPanelComponent } from './browser-unattended-panel.component';
import { BrowserUnattendedStore } from './browser-unattended.store';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';

const componentFiles = [
  'browser-unattended-panel.component',
  'browser-vault-control.component',
  'browser-credential-authorization-panel.component',
  'browser-campaign-list.component',
  'browser-escalation-queue.component',
];

const specDirectory = dirname(fileURLToPath(import.meta.url));
const templates = new Map(
  componentFiles.map((name) => [
    `${name}.html`,
    readFileSync(resolve(specDirectory, `./${name}.html`), 'utf8'),
  ]),
);
const styles = new Map(
  componentFiles.map((name) => [
    `${name}.scss`,
    readFileSync(resolve(specDirectory, `./${name}.scss`), 'utf8'),
  ]),
);

await resolveComponentResources((url) => {
  for (const [suffix, content] of templates) {
    if (url.endsWith(suffix)) {
      return Promise.resolve(content);
    }
  }
  for (const [suffix, content] of styles) {
    if (url.endsWith(suffix)) {
      return Promise.resolve(content);
    }
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('BrowserUnattendedPanelComponent', () => {
  let fixture: ComponentFixture<BrowserUnattendedPanelComponent>;
  let store: {
    vaultStatus: ReturnType<typeof vi.fn>;
    vaultBusy: ReturnType<typeof vi.fn>;
    vaultUnlockReason: ReturnType<typeof vi.fn>;
    authorizations: ReturnType<typeof vi.fn>;
    campaigns: ReturnType<typeof vi.fn>;
    campaignDetails: ReturnType<typeof vi.fn>;
    pendingEscalations: ReturnType<typeof vi.fn>;
    busy: ReturnType<typeof vi.fn>;
    errorMessage: ReturnType<typeof vi.fn>;
    refreshAll: ReturnType<typeof vi.fn>;
    refreshVaultStatus: ReturnType<typeof vi.fn>;
    refreshAuthorizations: ReturnType<typeof vi.fn>;
    refreshCampaigns: ReturnType<typeof vi.fn>;
    refreshEscalations: ReturnType<typeof vi.fn>;
  };
  let gatewayIpc: { listProfiles: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers();

    store = {
      vaultStatus: vi.fn(() => ({ locked: true, passwordSourceConfigured: true })),
      vaultBusy: vi.fn(() => false),
      vaultUnlockReason: vi.fn(() => null),
      authorizations: vi.fn(() => []),
      campaigns: vi.fn(() => []),
      campaignDetails: vi.fn(() => ({})),
      pendingEscalations: vi.fn(() => []),
      busy: vi.fn(() => false),
      errorMessage: vi.fn(() => null),
      refreshAll: vi.fn().mockResolvedValue(undefined),
      refreshVaultStatus: vi.fn().mockResolvedValue(undefined),
      refreshAuthorizations: vi.fn().mockResolvedValue(undefined),
      refreshCampaigns: vi.fn().mockResolvedValue(undefined),
      refreshEscalations: vi.fn().mockResolvedValue(undefined),
    };
    gatewayIpc = {
      listProfiles: vi.fn().mockResolvedValue({
        success: true,
        data: { decision: 'allowed', outcome: 'succeeded', auditId: 'a', data: [] },
      }),
    };

    await TestBed.configureTestingModule({
      imports: [BrowserUnattendedPanelComponent],
      providers: [
        { provide: BrowserUnattendedStore, useValue: store },
        { provide: BrowserGatewayIpcService, useValue: gatewayIpc },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserUnattendedPanelComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads profiles and refreshes the store on init', () => {
    expect(gatewayIpc.listProfiles).toHaveBeenCalled();
    expect(store.refreshAll).toHaveBeenCalled();
  });

  it('polls the store every ~10s while mounted', async () => {
    store.refreshAll.mockClear();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.refreshAll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.refreshAll).toHaveBeenCalledTimes(2);
  });

  it('stops polling after destroy', async () => {
    store.refreshAll.mockClear();
    fixture.destroy();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.refreshAll).not.toHaveBeenCalled();
  });
});
