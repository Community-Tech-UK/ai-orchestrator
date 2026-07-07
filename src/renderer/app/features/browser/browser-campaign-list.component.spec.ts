import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import type { BrowserProfile } from '@contracts/types/browser';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserCampaignListComponent } from './browser-campaign-list.component';
import { BrowserUnattendedStore } from './browser-unattended.store';
import type { BrowserCampaign, BrowserCampaignListItem } from './browser-unattended.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './browser-campaign-list.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './browser-campaign-list.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('browser-campaign-list.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('browser-campaign-list.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const profile: BrowserProfile = {
  id: 'profile-1',
  label: 'Local App',
  mode: 'session',
  browser: 'chrome',
  allowedOrigins: [],
  status: 'stopped',
  createdAt: 1,
  updatedAt: 1,
};

const campaign: BrowserCampaign = {
  id: 'campaign-1',
  label: 'Overnight run',
  profileId: 'profile-1',
  allowedOrigins: ['example.com'],
  allowedActionClasses: ['read', 'navigate'],
  budget: { maxActions: 100, maxSubmits: 20, maxNewAccounts: 0, maxUploads: 0, maxDurationMs: 3_600_000 },
  approvedDeclarationHashes: [],
  status: 'active',
  createdAt: 1,
  expiresAt: 2,
  approvedBy: 'user',
};

const campaignListItem: BrowserCampaignListItem = {
  campaign,
  counters: { actions: 1, submits: 3, newAccounts: 0, uploads: 0 },
};

function inputEvent(value: string): Event {
  return { target: { value } } as unknown as Event;
}

/**
 * The vitest config omits the Angular compiler plugin, so signal `input()`
 * metadata isn't generated and `setInput()` wiring fails. Override the input
 * getter directly — same workaround used by session-progress-panel.spec.
 */
function overrideProfilesInput(component: BrowserCampaignListComponent, profiles: BrowserProfile[]): void {
  (component as unknown as { profiles: () => BrowserProfile[] }).profiles = () => profiles;
}

describe('BrowserCampaignListComponent', () => {
  let fixture: ComponentFixture<BrowserCampaignListComponent>;
  let store: {
    campaigns: ReturnType<typeof vi.fn>;
    campaignDetails: ReturnType<typeof vi.fn>;
    busy: ReturnType<typeof vi.fn>;
    errorMessage: ReturnType<typeof vi.fn>;
    refreshCampaigns: ReturnType<typeof vi.fn>;
    createCampaign: ReturnType<typeof vi.fn>;
    pauseCampaign: ReturnType<typeof vi.fn>;
    resumeCampaign: ReturnType<typeof vi.fn>;
    killCampaign: ReturnType<typeof vi.fn>;
    loadCampaignDetail: ReturnType<typeof vi.fn>;
    approveDeclaration: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    store = {
      campaigns: vi.fn(() => [campaignListItem]),
      campaignDetails: vi.fn(() => ({})),
      busy: vi.fn(() => false),
      errorMessage: vi.fn(() => null),
      refreshCampaigns: vi.fn().mockResolvedValue(undefined),
      createCampaign: vi.fn().mockResolvedValue(true),
      pauseCampaign: vi.fn().mockResolvedValue(true),
      resumeCampaign: vi.fn().mockResolvedValue(true),
      killCampaign: vi.fn().mockResolvedValue(true),
      loadCampaignDetail: vi.fn().mockResolvedValue(undefined),
      approveDeclaration: vi.fn().mockResolvedValue(true),
    };

    await TestBed.configureTestingModule({
      imports: [BrowserCampaignListComponent],
      providers: [{ provide: BrowserUnattendedStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserCampaignListComponent);
    overrideProfilesInput(fixture.componentInstance, [profile]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('refreshes campaigns on init and defaults the profile selection', () => {
    expect(store.refreshCampaigns).toHaveBeenCalled();
    expect(fixture.componentInstance.selectedProfileId()).toBe('profile-1');
  });

  it('renders only the safe action classes and never offers credential/payment/destructive', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('read');
    expect(text).toContain('navigate');
    expect(text).toContain('submit');
    expect(text).toContain('file-upload');
    expect(text).toContain('file-download');
    expect(text).not.toContain('credential');
    expect(text).not.toContain('payment');
    expect(text).not.toContain('destructive');
  });

  it('rejects a campaign whose duration exceeds the 14h ceiling', async () => {
    const component = fixture.componentInstance;
    component.onLabelInput(inputEvent('Overnight run'));
    component.onOriginsInput(inputEvent('example.com'));
    component.toggleActionClass('read');
    component.onBudgetInput('durationHours', inputEvent('15'));

    await component.submitCampaign();

    expect(store.createCampaign).not.toHaveBeenCalled();
    expect(component.validationError()).toContain('14');
  });

  it('creates a campaign with only whitelisted action classes in the payload', async () => {
    const component = fixture.componentInstance;
    component.onLabelInput(inputEvent('Overnight run'));
    component.onOriginsInput(inputEvent('example.com\nexample.org'));
    component.toggleActionClass('read');
    component.toggleActionClass('submit');
    component.onBudgetInput('durationHours', inputEvent('8'));

    await component.submitCampaign();

    expect(store.createCampaign).toHaveBeenCalledTimes(1);
    const payload = store.createCampaign.mock.calls[0]![0];
    expect(payload.profileId).toBe('profile-1');
    expect(payload.allowedOrigins).toEqual(['example.com', 'example.org']);
    expect(payload.allowedActionClasses.sort()).toEqual(['read', 'submit']);
    expect(payload.budget.maxDurationMs).toBe(8 * 60 * 60 * 1000);
  });

  it('pauses, resumes, and kills a campaign from row actions', async () => {
    const component = fixture.componentInstance;
    await component.pause('campaign-1');
    expect(store.pauseCampaign).toHaveBeenCalledWith('campaign-1');

    await component.resume('campaign-1');
    expect(store.resumeCampaign).toHaveBeenCalledWith('campaign-1');

    await component.kill('campaign-1');
    expect(store.killCampaign).toHaveBeenCalledWith('campaign-1');
  });

  it('validates the declaration hash as 64 hex characters before approving', async () => {
    const component = fixture.componentInstance;
    await component.toggleExpand('campaign-1');
    expect(store.loadCampaignDetail).toHaveBeenCalledWith('campaign-1');

    component.onDeclarationHashInput('campaign-1', inputEvent('not-a-hash'));
    expect(component.isDeclarationHashValid('campaign-1')).toBe(false);

    await component.approveDeclaration('campaign-1');
    expect(store.approveDeclaration).not.toHaveBeenCalled();

    const hash = 'b'.repeat(64);
    component.onDeclarationHashInput('campaign-1', inputEvent(hash));
    expect(component.isDeclarationHashValid('campaign-1')).toBe(true);

    await component.approveDeclaration('campaign-1');
    expect(store.approveDeclaration).toHaveBeenCalledWith('campaign-1', hash);
  });
});
