import { describe, expect, it, vi } from 'vitest';
import { InstanceDetailComponent } from './instance-detail.component';

describe('queued-message restoration while the composer is absent', () => {
  it.each(['onCancelQueuedMessage', 'onEditQueuedMessage'] as const)('%s preserves the saved draft and attachments', (action) => {
    let draft = 'Already typed';
    const files = [new File(['attachment'], 'note.txt')];
    const addPendingFiles = vi.fn();
    const cancelQueuedMessage = vi.fn(() => ({ message: 'Queued text', files }));
    const component: InstanceDetailComponent = Object.assign(Object.create(InstanceDetailComponent.prototype), {
      instance: () => ({ id: 'session' }),
      inputPanel: () => undefined,
      store: { cancelQueuedMessage },
      draftService: {
        getDraft: () => draft,
        setDraft: (_id: string, value: string) => { draft = value; },
        addPendingFiles,
      },
    });

    component[action](2);

    expect(cancelQueuedMessage).toHaveBeenCalledWith('session', 2);
    expect(draft).toBe('Queued text\n\nAlready typed');
    expect(addPendingFiles).toHaveBeenCalledWith('session', files);
  });
});
