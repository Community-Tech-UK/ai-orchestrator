import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileAttachment, OutputMessage } from '../../shared/types/instance.types';
import {
  collectReplayImages,
  prepareReplayImageCarryover,
  replayMessagesForImages,
} from './replay-image-carryover';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-images-'));
  dirs.push(dir);
  return dir;
}

function image(name: string, data = 'data:image/png;base64,AAAA'): FileAttachment {
  return { name, type: 'image/png', size: 4, data };
}

function user(id: string, content: string, attachments?: FileAttachment[], timestamp = 1): OutputMessage {
  return { id, type: 'user', content, timestamp, ...(attachments ? { attachments } : {}) };
}

describe('collectReplayImages', () => {
  it('keeps user images and drops everything else', () => {
    const { images, omitted } = collectReplayImages([
      user('u1', 'please suspend this user.', [image('who.png')], 2),
      { id: 'a1', type: 'assistant', content: 'ok', timestamp: 3, attachments: [image('reply.png')] },
      user('u2', 'notes', [{ name: 'notes.txt', type: 'text/plain', size: 2, data: 'data:text/plain,hi' }], 4),
      user('u3', 'empty', [{ name: 'blank.png', type: 'image/png', size: 0, data: '' }], 5),
    ]);

    expect(omitted).toBe(0);
    expect(images.map((item) => item.name)).toEqual(['who.png']);
    expect(images[0]?.turnExcerpt).toBe('please suspend this user.');
  });

  it('keeps one copy when the same image is retained and still in the buffer', () => {
    const shot = image('who.png');
    const messages = replayMessagesForImages({
      retainedPrompts: [user('u1', 'please suspend this user.', [shot], 1)],
      outputBuffer: [user('u1', 'please suspend this user.', [shot], 1)],
    });

    expect(collectReplayImages(messages).images).toHaveLength(1);
  });

  it('keeps the opening image when later images exceed the cap', () => {
    const messages = Array.from({ length: 12 }, (_, index) => (
      user(`u${index}`, `turn ${index}`, [image(`shot-${index}.png`, `data:image/png;base64,${index}`)], index)
    ));

    const { images, omitted } = collectReplayImages(messages);

    expect(omitted).toBe(2);
    expect(images[0]?.name).toBe('shot-0.png');
    expect(images).toHaveLength(10);
    expect(images.at(-1)?.name).toBe('shot-11.png');
  });
});

describe('prepareReplayImageCarryover', () => {
  it('returns null when the conversation has no images', async () => {
    await expect(prepareReplayImageCarryover({
      messages: [user('u1', 'hello')],
      inline: false,
      sessionId: 'session-1',
      workingDirectory: tempDir(),
    })).resolves.toBeNull();
  });

  it('attaches the original bytes when the provider accepts images', async () => {
    const workspace = tempDir();
    const shot = image('who.png');
    const carryover = await prepareReplayImageCarryover({
      messages: [user('u1', 'please suspend this user.', [shot])],
      inline: true,
      sessionId: 'session-1',
      workingDirectory: workspace,
    });

    expect(carryover?.attachments).toEqual([shot]);
    expect(carryover?.note).toContain('please suspend this user.');
    expect(carryover?.note).toContain('who.png');
    expect(carryover?.note).not.toContain(workspace);
  });

  it('writes the original image and names its path when the provider refuses attachments', async () => {
    const workspace = tempDir();
    const carryover = await prepareReplayImageCarryover({
      messages: [user('u1', 'please suspend this user.', [image('who.png')])],
      inline: false,
      sessionId: 'session-1',
      workingDirectory: workspace,
    });

    expect(carryover?.attachments).toBeUndefined();
    expect(carryover?.note).toContain('please suspend this user.');
    expect(carryover?.note).toContain(path.join(workspace, '.claude-attachments', 'session-1', '1-who.png'));
    expect(carryover?.note).toContain('Read each file before you continue.');
  });

  it('still describes the image when the copy cannot be written', async () => {
    const blocked = path.join(tempDir(), 'not-a-directory');
    writeFileSync(blocked, 'file');

    const carryover = await prepareReplayImageCarryover({
      messages: [user('u1', 'please suspend this user.', [image('who.png')])],
      inline: false,
      sessionId: 'session-1',
      workingDirectory: blocked,
    });

    expect(carryover?.attachments).toBeUndefined();
    expect(carryover?.note).toContain('could not be copied');
    expect(carryover?.note).toContain('who.png');
    expect(carryover?.note).toContain('please suspend this user.');
  });
});
