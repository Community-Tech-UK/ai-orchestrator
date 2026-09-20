import { describe, expect, it, vi } from 'vitest';
import type { BrowserListGrantsRequest, BrowserPermissionGrant } from '@contracts/types/browser';
import type { BrowserGatewayIpcResponse } from '../../core/services/ipc/browser-gateway-ipc.service';
import { BrowserGrantPaginator } from './browser-grant-paginator';

type PageResponse = BrowserGatewayIpcResponse<BrowserPermissionGrant[]>;

function grant(index: number): BrowserPermissionGrant {
  return {
    id: `grant-${String(index).padStart(3, '0')}`,
    mode: 'session',
    instanceId: 'instance-1',
    provider: 'codex',
    profileId: 'profile-1',
    allowedOrigins: [{ scheme: 'https', hostPattern: 'example.com', includeSubdomains: false }],
    allowedActionClasses: ['input'],
    allowExternalNavigation: false,
    autonomous: false,
    requestedBy: 'instance-1',
    decidedBy: 'user',
    decision: 'allow',
    createdAt: index,
    expiresAt: 8_640_000_000_000_000,
  };
}

function page(newest: number): BrowserPermissionGrant[] {
  return Array.from({ length: 25 }, (_, index) => grant(newest - index));
}

function result(grants: BrowserPermissionGrant[]): PageResponse {
  return { success: true, data: { decision: 'allowed', outcome: 'succeeded', auditId: 'audit-1', data: grants } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  const request = vi.fn<(payload: BrowserListGrantsRequest) => Promise<PageResponse>>();
  const onError = vi.fn<(message: string) => void>();
  return { request, onError, paginator: new BrowserGrantPaginator(request, onError) };
}

describe('BrowserGrantPaginator', () => {
  it('keeps older grants reachable and reloads from the first page', async () => {
    const { request, paginator } = setup();
    request.mockResolvedValueOnce(result(page(27)))
      .mockResolvedValueOnce(result([grant(2), { ...grant(1), mode: 'persistent', autonomous: true }]))
      .mockResolvedValueOnce(result(page(28)));

    await paginator.reload();
    expect(paginator.grants()).toHaveLength(25);
    expect(paginator.hasMore()).toBe(true);
    await paginator.loadMore();

    expect(request).toHaveBeenNthCalledWith(2, { limit: 25, before: { createdAt: 3, id: 'grant-003' } });
    expect(paginator.grants()).toHaveLength(27);
    expect(paginator.grants().at(-1)?.mode).toBe('persistent');
    expect(paginator.hasMore()).toBe(false);
    await paginator.reload();

    expect(request).toHaveBeenNthCalledWith(3, { limit: 25 });
    expect(paginator.grants()).toEqual(page(28));
    expect(paginator.hasMore()).toBe(true);
  });

  it('deduplicates displayed rows while advancing with the last raw-page cursor', async () => {
    const { request, paginator } = setup();
    const secondPage = page(36);
    secondPage[0] = { ...secondPage[0]!, allowedActionClasses: ['read'] };
    request.mockResolvedValueOnce(result(page(60)))
      .mockResolvedValueOnce(result(secondPage))
      .mockResolvedValueOnce(result([grant(11)]));

    await paginator.reload();
    await paginator.loadMore();

    expect(paginator.grants()).toHaveLength(49);
    expect(paginator.grants().filter((row) => row.id === 'grant-036')).toHaveLength(1);
    expect(paginator.grants().find((row) => row.id === 'grant-036')?.allowedActionClasses).toEqual(['read']);
    expect(paginator.hasMore()).toBe(true);
    await paginator.loadMore();
    expect(request).toHaveBeenLastCalledWith({ limit: 25, before: { createdAt: 12, id: 'grant-012' } });
    expect(paginator.hasMore()).toBe(false);
  });

  it('allows only one load-more request at a time and stops at the end', async () => {
    const { request, paginator } = setup();
    const next = deferred<PageResponse>();
    request.mockResolvedValueOnce(result(page(25))).mockReturnValueOnce(next.promise);
    await paginator.reload();

    const loading = paginator.loadMore();
    await paginator.loadMore();
    expect(request).toHaveBeenCalledTimes(2);
    expect(paginator.loading()).toBe(true);
    next.resolve(result([]));
    await loading;
    expect(paginator.loading()).toBe(false);
    expect(paginator.grants()).toHaveLength(25);
    expect(paginator.hasMore()).toBe(false);
    await paginator.loadMore();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['IPC failure', 'transport rejection', 'invalid page'] as const)(
    'preserves rows and cursor after a load-more %s, allowing the same page to be retried', async (failure) => {
      const { request, paginator, onError } = setup();
      request.mockResolvedValueOnce(result(page(27)));
      await paginator.reload();
      if (failure === 'transport rejection') request.mockRejectedValueOnce(new Error('Transport failed'));
      else if (failure === 'IPC failure') request.mockResolvedValueOnce({ success: false, error: { message: 'Request failed' } });
      else request.mockResolvedValueOnce({ success: true });
      request.mockResolvedValueOnce(result([grant(2), grant(1)]));

      await paginator.loadMore();
      expect(paginator.grants()).toEqual(page(27));
      expect(paginator.hasMore()).toBe(true);
      expect(paginator.loading()).toBe(false);
      expect(onError).toHaveBeenCalledTimes(1);
      await paginator.loadMore();

      expect(request.mock.calls[2]?.[0]).toEqual(request.mock.calls[1]?.[0]);
      expect(paginator.grants()).toHaveLength(27);
      expect(paginator.hasMore()).toBe(false);
    },
  );

  it('retains the loaded inventory and next cursor when a reload fails', async () => {
    const { request, paginator, onError } = setup();
    request.mockResolvedValueOnce(result(page(27)))
      .mockRejectedValueOnce(new Error('Refresh failed'))
      .mockResolvedValueOnce(result([grant(2), grant(1)]));
    await paginator.reload();
    await paginator.reload();

    expect(paginator.grants()).toEqual(page(27));
    expect(paginator.hasMore()).toBe(true);
    expect(onError).toHaveBeenCalledWith('Refresh failed');
    await paginator.loadMore();
    expect(request).toHaveBeenLastCalledWith({ limit: 25, before: { createdAt: 3, id: 'grant-003' } });
    expect(paginator.grants()).toHaveLength(27);
  });

  it.each(['response', 'rejection'] as const)(
    'ignores a stale load-more %s while keeping a newer reload in progress', async (completion) => {
      const { request, paginator, onError } = setup();
      const stale = deferred<PageResponse>();
      const newest = deferred<PageResponse>();
      request.mockResolvedValueOnce(result(page(27)))
        .mockReturnValueOnce(stale.promise).mockReturnValueOnce(newest.promise);
      await paginator.reload();
      const more = paginator.loadMore();
      const reload = paginator.reload();

      if (completion === 'response') stale.resolve(result([grant(2), grant(1)]));
      else stale.reject(new Error('Stale load-more failed'));
      await more;
      expect(paginator.grants()).toEqual(page(27));
      expect(paginator.loading()).toBe(true);
      expect(onError).not.toHaveBeenCalled();
      newest.resolve(result(page(50)));
      await reload;
      expect(paginator.grants()).toEqual(page(50));
      expect(paginator.loading()).toBe(false);
    },
  );

  it('ignores an older reload that resolves after the newest inventory is visible', async () => {
    const { request, paginator } = setup();
    const stale = deferred<PageResponse>();
    request.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(result([grant(99)]));
    const oldReload = paginator.reload();
    await paginator.reload();
    stale.resolve(result(page(27)));
    await oldReload;

    expect(paginator.grants()).toEqual([grant(99)]);
    expect(paginator.hasMore()).toBe(false);
    expect(paginator.loading()).toBe(false);
  });
});
