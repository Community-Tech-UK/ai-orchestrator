import { signal } from '@angular/core';
import type { BrowserListGrantsRequest, BrowserPermissionGrant } from '@contracts/types/browser';
import type { BrowserGatewayIpcResponse } from '../../core/services/ipc/browser-gateway-ipc.service';

const GRANT_PAGE_SIZE = 25;

/** Keeps revocable grants reachable without letting stale pages replace newer inventory. */
export class BrowserGrantPaginator {
  readonly grants = signal<BrowserPermissionGrant[]>([]);
  readonly loading = signal(false);
  readonly hasMore = signal(false);
  private generation = 0;
  private before: BrowserListGrantsRequest['before'];

  constructor(
    private readonly request: (
      payload: BrowserListGrantsRequest,
    ) => Promise<BrowserGatewayIpcResponse<BrowserPermissionGrant[]>>,
    private readonly onError: (message: string) => void,
  ) {}

  reload(): Promise<void> {
    return this.load(false);
  }

  async loadMore(): Promise<void> {
    if (this.loading() || !this.hasMore() || !this.before) return;
    await this.load(true);
  }

  private async load(append: boolean): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    try {
      const response = await this.request({
        limit: GRANT_PAGE_SIZE,
        ...(append && this.before ? { before: this.before } : {}),
      });
      if (generation !== this.generation) return;
      if (!response.success) {
        this.onError(response.error?.message ?? 'Failed to load browser grants.');
        return;
      }
      const page = response.data?.data;
      if (!Array.isArray(page)) {
        this.onError('Browser Gateway returned an invalid grant page.');
        return;
      }
      const last = page.at(-1);
      this.before = last ? { createdAt: last.createdAt, id: last.id } : undefined;
      const combined = append ? [...this.grants(), ...page] : page;
      this.grants.set([...new Map(combined.map((grant) => [grant.id, grant])).values()]);
      this.hasMore.set(page.length === GRANT_PAGE_SIZE);
    } catch (error) {
      if (generation === this.generation) {
        this.onError(error instanceof Error ? error.message : 'Failed to load browser grants.');
      }
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
