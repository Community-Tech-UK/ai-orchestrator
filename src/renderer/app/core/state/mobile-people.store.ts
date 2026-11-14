/**
 * The people who use the phone app besides the owner, so a session started from
 * someone else's phone can say whose it is.
 */
import { Injectable, inject, signal } from '@angular/core';
import { MobileGatewayIpcService } from '../services/ipc/mobile-gateway-ipc.service';
import type { MobileMemberProfile } from '../../../../shared/types/mobile-gateway.types';

@Injectable({ providedIn: 'root' })
export class MobilePeopleStore {
  private readonly ipc = inject(MobileGatewayIpcService);
  private readonly _members = signal<MobileMemberProfile[]>([]);
  private loading: Promise<void> | null = null;

  readonly members = this._members.asReadonly();

  /** Reads the people once; later changes arrive through `refresh`. A failed read is tried again on the next call. */
  ensureLoaded(): Promise<void> {
    this.loading ??= this.refresh().then((loaded) => {
      if (!loaded) this.loading = null;
    });
    return this.loading;
  }

  /** True when the list was read. */
  async refresh(): Promise<boolean> {
    const overview = await this.ipc.listPeople();
    if (overview) this._members.set(overview.members);
    return overview !== null;
  }

  /** The person's name, or undefined when they are not (or no longer) on the list. */
  nameOf(profileId: string): string | undefined {
    return this._members().find((member) => member.profileId === profileId)?.name;
  }
}
