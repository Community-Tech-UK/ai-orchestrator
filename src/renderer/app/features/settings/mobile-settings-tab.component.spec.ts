/**
 * The People card in Settings > Mobile: who may use the phone app, where their
 * sessions run, and whose phone a pairing code is for.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileSettingsTabComponent } from './mobile-settings-tab.component';
import { MobileGatewayIpcService } from '../../core/services/ipc/mobile-gateway-ipc.service';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';
import { MobilePeopleStore } from '../../core/state/mobile-people.store';
import { ConfirmService } from '../../shared/confirm/confirm.service';
import type { MobilePeopleOverview } from '../../../../shared/types/mobile-gateway.types';

const overview = (session?: { workerNodeId: string; workingDirectory: string; allowedAccountProfileIds: string[] }): MobilePeopleOverview => ({
  members: [{ profileId: 'p1', name: 'Second person', createdAt: 1, ...(session ? { session } : {}) }],
  computers: [{ id: 'her-worker', name: 'Her computer', online: true }],
  accounts: [{ id: 'acct-claude', provider: 'claude', label: 'Claude A' }],
});

describe('MobileSettingsTabComponent people', () => {
  const ipc = {
    getStatus: vi.fn(),
    listDevices: vi.fn(),
    listPeople: vi.fn(),
    addPerson: vi.fn(),
    removePerson: vi.fn(),
    setPersonSession: vi.fn(),
    issuePairing: vi.fn(),
  };
  const confirm = vi.fn();
  let fixture: ComponentFixture<MobileSettingsTabComponent>;
  let root: HTMLElement;

  async function open(people: MobilePeopleOverview, running = true) {
    ipc.getStatus.mockResolvedValue({ running, tailscaleIp: '100.64.0.1', pushConfigured: false, connectedClientCount: 0, pairedDeviceCount: 0 });
    ipc.listPeople.mockResolvedValue(people);
    await TestBed.configureTestingModule({
      imports: [MobileSettingsTabComponent],
      providers: [
        { provide: MobileGatewayIpcService, useValue: ipc },
        { provide: SettingsIpcService, useValue: { getSettings: vi.fn().mockResolvedValue({ success: false }), setSetting: vi.fn() } },
        { provide: MobilePeopleStore, useValue: { refresh: vi.fn().mockResolvedValue(undefined) } },
        { provide: ConfirmService, useValue: { confirm } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MobileSettingsTabComponent);
    root = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.textContent).toContain('Second person');
    });
  }

  const button = (label: string) =>
    Array.from(root.querySelectorAll('button')).find((el) => el.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined;

  /** Lets the awaited calls in the component finish, then redraws. */
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ipc.listDevices.mockResolvedValue([]);
    ipc.addPerson.mockResolvedValue(undefined);
    ipc.removePerson.mockResolvedValue(true);
    ipc.setPersonSession.mockResolvedValue(undefined);
    ipc.issuePairing.mockResolvedValue(null);
    confirm.mockResolvedValue(true);
  });

  it('says a person who is not set up cannot start sessions yet, and keeps Save disabled until the choices are complete', async () => {
    await open(overview());

    expect(root.textContent).toContain('Not set up yet');
    expect(button('Save choices')?.disabled).toBe(true);

    const select = root.querySelector('select') as HTMLSelectElement;
    select.value = 'her-worker';
    select.dispatchEvent(new Event('change'));
    const folder = root.querySelector('input[placeholder="/home/cyntia/work"]') as HTMLInputElement;
    folder.value = '/home/member/work';
    folder.dispatchEvent(new Event('input'));
    const tick = root.querySelector('.person input[type="checkbox"]') as HTMLInputElement;
    tick.click();
    await settle();

    expect(button('Save choices')?.disabled).toBe(false);
    button('Save choices')!.click();
    await settle();

    expect(ipc.setPersonSession).toHaveBeenCalledWith({
      profileId: 'p1',
      workerNodeId: 'her-worker',
      workingDirectory: '/home/member/work',
      allowedAccountProfileIds: ['acct-claude'],
    });
  });

  it('starts the choices from what is already saved', async () => {
    await open(overview({ workerNodeId: 'her-worker', workingDirectory: '/home/member/work', allowedAccountProfileIds: ['acct-claude'] }));

    expect(root.textContent).not.toContain('Not set up yet');
    expect((root.querySelector('select') as HTMLSelectElement).value).toBe('her-worker');
    expect(button('Save choices')?.disabled).toBe(false);
  });

  it('adds a person by name and shows the reason when it is refused', async () => {
    await open(overview());
    const name = root.querySelector('input[aria-label="Name of the person to add"]') as HTMLInputElement;
    name.value = 'New person';
    name.dispatchEvent(new Event('input'));
    await settle();

    button('Add person')!.click();
    await settle();
    expect(ipc.addPerson).toHaveBeenCalledWith('New person');

    ipc.addPerson.mockRejectedValueOnce(new Error('Enter a name for this person.'));
    name.value = 'Another';
    name.dispatchEvent(new Event('input'));
    await settle();
    button('Add person')!.click();
    await settle();
    expect(root.querySelector('.banner.error')?.textContent).toContain('Enter a name for this person.');
  });

  it('asks before removing a person and names what happens', async () => {
    await open(overview());
    confirm.mockResolvedValueOnce(false);

    button('Remove Second person')!.click();
    await settle();
    expect(ipc.removePerson).not.toHaveBeenCalled();

    button('Remove Second person')!.click();
    await settle();
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ danger: true, message: expect.stringContaining('disconnect') }));
    expect(ipc.removePerson).toHaveBeenCalledWith('p1');
  });

  it("issues a pairing code for the person whose phone is chosen, and for the owner's by default", async () => {
    await open(overview());

    button('Generate pairing code')!.click();
    await settle();
    expect(ipc.issuePairing).toHaveBeenLastCalledWith(undefined);

    const choice = Array.from(root.querySelectorAll('select')).find((el) => el.textContent?.includes('Mine')) as HTMLSelectElement;
    choice.value = 'p1';
    choice.dispatchEvent(new Event('change'));
    await settle();
    button('Generate pairing code')!.click();
    await settle();
    expect(ipc.issuePairing).toHaveBeenLastCalledWith('p1');
  });
});
