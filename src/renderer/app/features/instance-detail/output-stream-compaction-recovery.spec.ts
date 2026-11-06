import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService } from '../../core/services/ipc';
import { CompactionRecoveryController } from './output-stream-compaction-recovery';

describe('CompactionRecoveryController', () => {
  const recoverCompactionContext = vi.fn();
  let controller: CompactionRecoveryController;
  let consoleError: ReturnType<typeof vi.spyOn>;

  const click = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as MouseEvent;

  beforeEach(() => {
    recoverCompactionContext.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.configureTestingModule({ providers: [{ provide: InstanceIpcService, useValue: { recoverCompactionContext } }] });
    controller = TestBed.runInInjectionContext(() => new CompactionRecoveryController(() => 'inst-1'));
  });

  afterEach(() => consoleError.mockRestore());

  it('starts with a plain button for every marker', () => {
    expect(controller.label('m1')).toBe('Recover context');
    expect(controller.isDisabled('m1')).toBe(false);
  });

  it('shows Recovering while the request is out, then Queued once it is accepted', async () => {
    let finish: (value: { success: boolean }) => void = () => undefined;
    recoverCompactionContext.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = controller.recover(click(), 'm1');
    expect(controller.label('m1')).toBe('Recovering');
    expect(controller.isDisabled('m1')).toBe(true);

    finish({ success: true });
    await pending;
    expect(controller.label('m1')).toBe('Queued');
    expect(controller.isDisabled('m1')).toBe(true);
    expect(recoverCompactionContext).toHaveBeenCalledWith('inst-1', 'm1');
  });

  it('offers a retry when the request is refused or throws', async () => {
    recoverCompactionContext.mockResolvedValueOnce({ success: false, error: { message: 'nope' } });
    await controller.recover(click(), 'm1');
    expect(controller.label('m1')).toBe('Retry recover');
    expect(controller.isDisabled('m1')).toBe(false);

    recoverCompactionContext.mockRejectedValueOnce(new Error('ipc down'));
    await controller.recover(click(), 'm1');
    expect(controller.label('m1')).toBe('Retry recover');
  });

  it('keeps each marker separate and ignores a second click while one is in flight', async () => {
    recoverCompactionContext.mockResolvedValue({ success: true });
    await controller.recover(click(), 'm1');
    await controller.recover(click(), 'm1');
    expect(recoverCompactionContext).toHaveBeenCalledTimes(1);
    expect(controller.label('m2')).toBe('Recover context');
  });

  it('stops the click from reaching the message under it, and ignores a missing marker', async () => {
    const event = click();
    await controller.recover(event, '');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(recoverCompactionContext).not.toHaveBeenCalled();
  });
});
