import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileIpcService } from '../../core/services/ipc';
import type { FailedImageRef, FileAttachment, OutputMessage } from '../../../../shared/types/instance.types';
import { ImageAttachmentService, type ImageAttachmentSink } from './image-attachment.service';

describe('ImageAttachmentService', () => {
  let service: ImageAttachmentService;
  let fileIpc: { resolveImage: ReturnType<typeof vi.fn> };
  let sink: ImageAttachmentSink;

  beforeEach(() => {
    TestBed.resetTestingModule();
    fileIpc = {
      resolveImage: vi.fn(),
    };
    sink = {
      appendAttachmentsToMessage: vi.fn(),
      markImagesResolved: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        ImageAttachmentService,
        { provide: FileIpcService, useValue: fileIpc },
      ],
    });

    service = TestBed.inject(ImageAttachmentService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('resolves extracted image references into attachments', async () => {
    fileIpc.resolveImage.mockResolvedValue({
      ok: true,
      attachment: {
        name: 'preview.png',
        type: 'image/png',
        size: 42,
        data: 'data:image/png;base64,Zm9v',
      },
    });

    await service.processMessage(
      'inst-1',
      assistantMessage('![preview](/tmp/preview.png)'),
      sink,
    );

    expect(fileIpc.resolveImage).toHaveBeenCalledWith({
      kind: 'local',
      src: '/tmp/preview.png',
      alt: 'preview',
    });
    expect(sink.appendAttachmentsToMessage).toHaveBeenCalledWith(
      'inst-1',
      'msg-1',
      [
        {
          name: 'preview.png',
          type: 'image/png',
          size: 42,
          data: 'data:image/png;base64,Zm9v',
        } satisfies FileAttachment,
      ],
      [],
    );
    expect(sink.markImagesResolved).toHaveBeenCalledWith('inst-1', 'msg-1');
  });

  it('records failed resolutions', async () => {
    fileIpc.resolveImage.mockResolvedValue({
      ok: false,
      reason: 'not_found',
      message: 'Image missing',
    });

    await service.processMessage(
      'inst-1',
      assistantMessage('https://example.com/missing.png'),
      sink,
    );

    expect(sink.appendAttachmentsToMessage).toHaveBeenCalledWith(
      'inst-1',
      'msg-1',
      [],
      [
        {
          src: 'https://example.com/missing.png',
          kind: 'remote',
          reason: 'not_found',
          message: 'Image missing',
        } satisfies FailedImageRef,
      ],
    );
    expect(sink.markImagesResolved).toHaveBeenCalledWith('inst-1', 'msg-1');
  });

  it('marks messages without image references as resolved without IPC calls', async () => {
    await service.processMessage(
      'inst-1',
      assistantMessage('No images here'),
      sink,
    );

    expect(fileIpc.resolveImage).not.toHaveBeenCalled();
    expect(sink.appendAttachmentsToMessage).not.toHaveBeenCalled();
    expect(sink.markImagesResolved).toHaveBeenCalledWith('inst-1', 'msg-1');
  });

  it('defers streaming messages until finalized', async () => {
    await service.processMessage(
      'inst-1',
      {
        ...assistantMessage('![preview](/tmp/preview.png)'),
        metadata: { streaming: true },
      },
      sink,
    );

    expect(fileIpc.resolveImage).not.toHaveBeenCalled();
    expect(sink.markImagesResolved).not.toHaveBeenCalled();
  });
});

function assistantMessage(content: string): OutputMessage {
  return {
    id: 'msg-1',
    timestamp: Date.now(),
    type: 'assistant',
    content,
  };
}
