import { FILE_CHANNELS } from '../file.channels';

describe('FILE_CHANNELS', () => {
  it('has correct values for file operations', () => {
    expect(FILE_CHANNELS.FILE_DROP).toBe('file:drop');
    expect(FILE_CHANNELS.FILE_READ_DIR).toBe('file:read-dir');
    expect(FILE_CHANNELS.FILE_WRITE_TEXT).toBe('file:write-text');
  });

  it('has correct values for editor operations', () => {
    expect(FILE_CHANNELS.EDITOR_DETECT).toBe('editor:detect');
    expect(FILE_CHANNELS.EDITOR_OPEN_FILE_AT_LINE).toBe('editor:open-file-at-line');
  });

  it('has correct values for dialog operations', () => {
    expect(FILE_CHANNELS.DIALOG_SELECT_FOLDER).toBe('dialog:select-folder');
    expect(FILE_CHANNELS.DIALOG_SELECT_FILES).toBe('dialog:select-files');
  });

  it('has correct values for image operations', () => {
    expect(FILE_CHANNELS.IMAGE_PASTE).toBe('image:paste');
    expect(FILE_CHANNELS.IMAGE_COPY_TO_CLIPBOARD).toBe('image:copy-to-clipboard');
  });
});
