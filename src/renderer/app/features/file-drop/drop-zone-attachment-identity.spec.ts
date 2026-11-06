import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropZoneComponent } from './drop-zone.component';
import { DraftService } from '../../core/services/draft.service';
import { ToastService } from '../../core/services/toast.service';

function file(text: string, name = 'same.txt'): File {
  const result = new File([text], name, { type: 'text/plain', lastModified: 1 });
  Object.defineProperty(result, 'arrayBuffer', { value: async () => new TextEncoder().encode(text).buffer });
  return result;
}

function drop(files: File[]): DragEvent {
  return {
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    dataTransfer: {
      files, items: files.map(() => ({ webkitGetAsEntry: () => ({ isDirectory: false }) })),
      getData: () => '',
    },
  } as unknown as DragEvent;
}

describe('native drop attachment identity', () => {
  let fixture: ComponentFixture<DropZoneComponent>;
  let drafts: DraftService;
  const show = vi.fn();

  beforeEach(async () => {
    show.mockReset();
    await TestBed.configureTestingModule({
      imports: [DropZoneComponent],
      providers: [DraftService, { provide: ToastService, useValue: { show } }],
    }).compileComponents();
    fixture = TestBed.createComponent(DropZoneComponent);
    drafts = TestBed.inject(DraftService);
    fixture.componentInstance.filesDropped.subscribe(files => drafts.addPendingFiles('session', files));
  });

  afterEach(() => TestBed.resetTestingModule());

  it('preserves different dropped bytes with identical name, size, type and modified time', async () => {
    const first = file('left');
    const second = file('rght');
    await fixture.componentInstance.onDrop(drop([first]));
    await fixture.componentInstance.onDrop(drop([second]));
    expect(drafts.getPendingFiles('session')).toEqual([first, second]);
    expect(show).not.toHaveBeenCalled();
  });

  it('still skips equal dropped bytes under different names', async () => {
    const first = file('same', 'one.txt');
    const second = file('same', 'two.txt');
    await fixture.componentInstance.onDrop(drop([first]));
    await fixture.componentInstance.onDrop(drop([second]));
    expect(drafts.getPendingFiles('session')).toEqual([first]);
    expect(show).toHaveBeenCalledExactlyOnceWith('Already attached.');
  });

  it('preserves distinct unverified files while skipping the exact same File object', () => {
    const first = file('left');
    const second = file('rght');
    expect(drafts.addPendingFiles('session', [first, second, first])).toBe(1);
    expect(drafts.getPendingFiles('session')).toEqual([first, second]);
  });

  it.each(['draft switch', 'owner callback replacement', 'destroy'] as const)(
    'does not emit delayed files after %s', async (change) => {
      let owner = 'first';
      const readOwner = () => owner;
      fixture.componentRef.setInput('pasteOwner', readOwner);
      let finish!: (buffer: ArrayBuffer) => void;
      const delayed = new File(['late'], 'late.txt', { type: 'text/plain' });
      Object.defineProperty(delayed, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }) });
      const emit = vi.spyOn(fixture.componentInstance.filesDropped, 'emit');
      const pending = fixture.componentInstance.onDrop(drop([delayed]));
      if (change === 'draft switch') owner = 'second';
      else if (change === 'owner callback replacement') fixture.componentRef.setInput('pasteOwner', () => owner);
      else fixture.destroy();
      finish(new TextEncoder().encode('late').buffer);
      await pending;
      expect(emit).not.toHaveBeenCalled();
      expect(drafts.getPendingFiles('session')).toEqual([]);
      expect(show).not.toHaveBeenCalled();
    },
  );
});
