import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobilePeopleStore } from './mobile-people.store';
import { MobileGatewayIpcService } from '../services/ipc/mobile-gateway-ipc.service';
import type { MobilePeopleOverview } from '../../../../shared/types/mobile-gateway.types';

const overview: MobilePeopleOverview = {
  members: [{ profileId: 'p1', name: 'Second person', createdAt: 1 }],
  computers: [],
  accounts: [],
};

describe('MobilePeopleStore', () => {
  const listPeople = vi.fn();
  let store: MobilePeopleStore;

  beforeEach(() => {
    listPeople.mockReset();
    TestBed.configureTestingModule({ providers: [{ provide: MobileGatewayIpcService, useValue: { listPeople } }] });
    store = TestBed.inject(MobilePeopleStore);
  });

  it('reads the people once and names a person by id', async () => {
    listPeople.mockResolvedValue(overview);

    await store.ensureLoaded();
    await store.ensureLoaded();

    expect(listPeople).toHaveBeenCalledTimes(1);
    expect(store.nameOf('p1')).toBe('Second person');
    expect(store.nameOf('gone')).toBeUndefined();
  });

  it('tries again on the next call after a failed read', async () => {
    listPeople.mockResolvedValueOnce(null).mockResolvedValueOnce(overview);

    await store.ensureLoaded();
    expect(store.members()).toEqual([]);
    await store.ensureLoaded();

    expect(listPeople).toHaveBeenCalledTimes(2);
    expect(store.nameOf('p1')).toBe('Second person');
  });
});
