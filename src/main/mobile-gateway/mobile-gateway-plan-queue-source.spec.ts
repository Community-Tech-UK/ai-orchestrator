import { beforeEach, describe, expect, it, vi } from 'vitest';

const coordinator = {
  getItem: vi.fn(),
  control: vi.fn(async () => undefined),
};

vi.mock('../plan-queue/plan-queue-coordinator', () => ({ getPlanQueueCoordinator: () => coordinator }));

import { createLivePlanQueueSource } from './mobile-gateway-plan-queue-source';

describe('phone direct-change choice on the live Plan Queue', () => {
  beforeEach(() => {
    coordinator.getItem.mockReset();
    coordinator.control.mockClear();
  });

  it('takes the job\'s version as a callerless Land anyway, like the Plan Queue page', async () => {
    coordinator.getItem.mockReturnValue({ id: 'item-1', state: 'parked', parkReason: 'undoes-direct-change' });
    await createLivePlanQueueSource().chooseDirectChange('item-1', 'take-job-version');
    expect(coordinator.control).toHaveBeenCalledWith({ action: 'land-anyway', itemId: 'item-1' });
    expect(coordinator.control.mock.calls[0]).toHaveLength(1);
  });

  it('keeps the change by resuming the job', async () => {
    coordinator.getItem.mockReturnValue({ id: 'item-1', state: 'parked', parkReason: 'undoes-direct-change' });
    await createLivePlanQueueSource().chooseDirectChange('item-1', 'keep-change');
    expect(coordinator.control).toHaveBeenCalledWith({ action: 'resume-item', itemId: 'item-1' });
  });

  it.each([
    [{ state: 'parked', parkReason: 'round-limit' }],
    [{ state: 'parked', parkReason: 'land-blocked' }],
    [{ state: 'landing', parkReason: null }],
  ])('refuses a job that is not waiting for that choice (%o), so the phone cannot land other jobs', async (item) => {
    coordinator.getItem.mockReturnValue({ id: 'item-1', ...item });
    await expect(createLivePlanQueueSource().chooseDirectChange('item-1', 'take-job-version'))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(coordinator.control).not.toHaveBeenCalled();
  });
});
