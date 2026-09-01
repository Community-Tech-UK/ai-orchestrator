import { describe, expect, it, vi } from 'vitest';
import {
  MAIN_PROCESS_HEAP_FLAG,
  startHarnessMainProcess,
} from './main-process-bootstrap';

describe('main-process bootstrap', () => {
  it('relaunches once with the permanent 8 GiB heap ceiling before loading the app', async () => {
    const app = {
      relaunch: vi.fn(),
      exit: vi.fn(),
    };
    const loadMain = vi.fn();

    await startHarnessMainProcess({
      app,
      argv: ['/Applications/Harness.app/Contents/MacOS/Harness'],
      loadMain,
    });

    expect(app.relaunch).toHaveBeenCalledWith({ args: [MAIN_PROCESS_HEAP_FLAG] });
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(loadMain).not.toHaveBeenCalled();
  });

  it('preserves launch arguments while adding the heap ceiling', async () => {
    const app = {
      relaunch: vi.fn(),
      exit: vi.fn(),
    };

    await startHarnessMainProcess({
      app,
      argv: ['Harness.exe', 'harness://resume/session-123', '--hidden'],
      loadMain: vi.fn(),
    });

    expect(app.relaunch).toHaveBeenCalledWith({
      args: [MAIN_PROCESS_HEAP_FLAG, 'harness://resume/session-123', '--hidden'],
    });
  });

  it('loads the real main module without relaunching when the ceiling is active', async () => {
    const app = {
      relaunch: vi.fn(),
      exit: vi.fn(),
    };
    const loadMain = vi.fn().mockResolvedValue(undefined);

    await startHarnessMainProcess({
      app,
      argv: ['Harness', MAIN_PROCESS_HEAP_FLAG],
      loadMain,
    });

    expect(app.relaunch).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
    expect(loadMain).toHaveBeenCalledOnce();
  });
});
