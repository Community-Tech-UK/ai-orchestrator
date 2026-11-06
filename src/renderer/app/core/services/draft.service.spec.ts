import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftService } from './draft.service';
import { ToastService } from './toast.service';
import { fingerprintFile } from './attachment-identity';

describe('DraftService pending attachments', () => {
  let drafts: DraftService;
  const show = vi.fn();

  beforeEach(() => {
    show.mockReset();
    TestBed.configureTestingModule({
      providers: [DraftService, { provide: ToastService, useValue: { show } }],
    });
    drafts = TestBed.inject(DraftService);
  });

  it('keeps one copy across arrivals and one notice per skipped arrival', async () => {
    const first = new File(['same bytes'], 'first.png', { type: 'image/png' });
    const repeat = new File(['same bytes'], 'renamed.png', { type: 'image/png' });
    const different = new File(['different!'], 'renamed.png', { type: 'image/png' });
    await Promise.all([first, repeat, different].map(fingerprintFile));

    expect(drafts.addPendingFiles('session', [first])).toBe(0);
    expect(drafts.addPendingFiles('session', [repeat, repeat, different])).toBe(2);
    expect(drafts.getPendingFiles('session')).toEqual([first, different]);
    expect(show).toHaveBeenCalledExactlyOnceWith('Already attached.');
  });
});
