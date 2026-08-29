import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityFilter } from '../remote-node/security-filter';
import { stageBrowserUploadOnNode } from './browser-remote-upload-staging';

const copyToRemote = vi.fn(async () => ({
  ok: true as const,
  size: 8,
  sha256: 'a'.repeat(64),
  from: 'a',
  to: 'b',
}));
const getNode = vi.fn();

vi.mock('../remote-node/file-transfer-service', () => ({
  getFileTransferService: () => ({ copyToRemote }),
}));

vi.mock('../remote-node/worker-node-registry', () => ({
  getWorkerNodeRegistry: () => ({ getNode }),
}));

function nodeWithWorkingDirectories(workingDirectories: string[]) {
  return { capabilities: { workingDirectories } };
}

describe('stageBrowserUploadOnNode', () => {
  beforeEach(() => {
    copyToRemote.mockClear();
    getNode.mockReset();
  });

  it('stages into a Windows-style _scratch path when the node root is a Windows path', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['C:\\work\\aio']));

    const staged = await stageBrowserUploadOnNode('node-1', '/Users/james/build/app release.aab');

    expect(staged.remotePath).toMatch(
      /^C:\\work\\aio\\_scratch\\aio-browser-uploads\\[0-9a-f-]+\\app release\.aab$/,
    );
    expect(staged).toMatchObject({
      size: 8,
      sha256: 'a'.repeat(64),
      integrity: 'size-and-sha256',
    });
    expect(copyToRemote).toHaveBeenCalledWith({
      localPath: '/Users/james/build/app release.aab',
      remotePath: staged.remotePath,
      nodeId: 'node-1',
    });
  });

  it('stages into a POSIX-style _scratch path when the node root is a POSIX path', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    const staged = await stageBrowserUploadOnNode('node-1', '/Users/james/build/app.aab');

    expect(staged.remotePath).toMatch(
      /^\/home\/james\/aio\/_scratch\/aio-browser-uploads\/[0-9a-f-]+\/app\.aab$/,
    );
  });

  // Regression: the staged basename is what DOM.setFileInputFiles hands the
  // page, so it is the filename the receiving site shows. Folding the
  // uniqueness UUID into the basename renamed an approved tender document in
  // front of a public-sector buyer on 2026-08-28. The UUID must stay in a
  // directory component.
  it('preserves the original filename exactly, keeping uniqueness in a directory', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    const staged = await stageBrowserUploadOnNode(
      'node-1',
      '/Users/suas/work/communitytech/tender-radar/responses/Liverpool-LCRCA-CRM-CCaaS-PME-Community-Tech-DRAFT.docx',
    );

    const posix = staged.remotePath.split('/');
    expect(posix[posix.length - 1]).toBe(
      'Liverpool-LCRCA-CRM-CCaaS-PME-Community-Tech-DRAFT.docx',
    );
    expect(posix[posix.length - 2]).toMatch(/^[0-9a-f-]+$/);
  });

  it('gives two concurrent stagings of the same filename distinct paths', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    const first = await stageBrowserUploadOnNode('node-1', '/tmp/report.docx');
    const second = await stageBrowserUploadOnNode('node-1', '/tmp/report.docx');

    expect(first.remotePath).not.toBe(second.remotePath);
    expect(first.remotePath.endsWith('/report.docx')).toBe(true);
    expect(second.remotePath.endsWith('/report.docx')).toBe(true);
  });

  // Restoring the real basename re-exposes the node's restricted-name guard,
  // which the `<uuid>-` prefix used to mask. This is the guard working as
  // designed, but it IS a new way a legitimately-named document can be refused,
  // so pin it rather than discover it on a deadline.
  it('now surfaces the node restricted-name guard for sensitive-looking filenames', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    const staged = await stageBrowserUploadOnNode('node-1', '/tmp/token.json');

    expect(staged.remotePath.endsWith('/token.json')).toBe(true);
    // The transfer itself will be refused downstream by the node handler.
    expect(SecurityFilter.isRestrictedPath(staged.remotePath)).toBe(true);
  });

  it('leaves an ordinary tender document unrestricted', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    const staged = await stageBrowserUploadOnNode(
      'node-1',
      '/tmp/Liverpool-LCRCA-CRM-CCaaS-PME-Community-Tech-DRAFT.docx',
    );

    expect(SecurityFilter.isRestrictedPath(staged.remotePath)).toBe(false);
  });

  // The basename is what the receiving SITE shows. An allowlist that replaced
  // spaces and accents renamed real tender documents in front of a buyer --
  // quieter than the UUID prefix, same defect.
  it('preserves spaces, brackets, commas and accents in the filename', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    const staged = await stageBrowserUploadOnNode(
      'node-1',
      '/tmp/Liverpool City Region (Q1), Response v2 \u2013 R\u00e9ponse.docx',
    );

    expect(staged.remotePath.split('/').at(-1)).toBe(
      'Liverpool City Region (Q1), Response v2 \u2013 R\u00e9ponse.docx',
    );
  });

  it('still strips characters a filesystem cannot accept', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['C:\\work\\aio']));

    const staged = await stageBrowserUploadOnNode('node-1', '/tmp/bad:name?v1*.docx');

    // Windows rejects : ? * outright; keeping them would fail the write.
    expect(staged.remotePath.split('\\').at(-1)).toBe('bad_name_v1_.docx');
  });

  it('neutralises Windows reserved device names', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['C:\\work\\aio']));

    // Windows resolves CON/PRN/AUX/NUL/COM1..9 to devices whatever the
    // extension, and the staging target IS a Windows node, so `CON.docx` would
    // never become a file.
    const staged = await stageBrowserUploadOnNode('node-1', '/tmp/CON.docx');

    expect(staged.remotePath.split('\\').at(-1)).toBe('file-CON.docx');
  });

  it('truncates an over-long basename without losing the extension', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    const staged = await stageBrowserUploadOnNode('node-1', `/tmp/${'a'.repeat(400)}.docx`);
    const basename = staged.remotePath.split('/').at(-1) as string;

    // NTFS caps a path component at 255 characters; the receiving site still
    // needs the right file type.
    expect(basename.length).toBe(255);
    expect(basename.endsWith('.docx')).toBe(true);
  });

  it('preserves a leading dot rather than renaming a dotfile', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    const staged = await stageBrowserUploadOnNode('node-1', '/tmp/.htaccess');

    expect(staged.remotePath.split('/').at(-1)).toBe('.htaccess');
  });

  it('caps the basename by BYTES, not UTF-16 units', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    // ext4 caps at 255 bytes: 200 three-byte characters is 600 bytes but only
    // 200 "characters", so a character-based cap still fails ENAMETOOLONG.
    // Emoji are SURROGATE PAIRS, so a UTF-16 `slice` can cut one in half. The
    // previous fixture used a BMP character, which never exercises that path,
    // and `normalize()` cannot detect a lone surrogate anyway (it is its own
    // NFC form).
    const staged = await stageBrowserUploadOnNode('node-1', `/tmp/${'\u{1F600}'.repeat(100)}.docx`);
    const basename = staged.remotePath.split('/').at(-1) as string;

    expect(Buffer.byteLength(basename, 'utf8')).toBeLessThanOrEqual(255);
    expect(basename.endsWith('.docx')).toBe(true);
    expect(basename).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(basename).not.toMatch(/(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('does not apply Windows naming rules to a POSIX node', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    // `Q1: Response.docx` and `CON.docx` are legal on ext4/APFS. Renaming them
    // there is the same defect as the UUID prefix: a document renamed in front
    // of the recipient.
    const colon = await stageBrowserUploadOnNode('node-1', '/tmp/Q1: Response.docx');
    const device = await stageBrowserUploadOnNode('node-1', '/tmp/CON.docx');

    expect(colon.remotePath.split('/').at(-1)).toBe('Q1: Response.docx');
    expect(device.remotePath.split('/').at(-1)).toBe('CON.docx');
  });

  it('fails with a clear error when the node has no working directory', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories([]));

    await expect(stageBrowserUploadOnNode('node-1', '/tmp/app.aab')).rejects.toThrow(
      'upload_file_remote_staging_unavailable',
    );
    expect(copyToRemote).not.toHaveBeenCalled();
  });

  it('fails with a clear error when the node is not connected', async () => {
    getNode.mockReturnValue(undefined);

    await expect(stageBrowserUploadOnNode('node-1', '/tmp/app.aab')).rejects.toThrow(
      'upload_file_remote_staging_unavailable',
    );
  });

  it('surfaces integrity verification failures from the remote file transfer', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));
    copyToRemote.mockRejectedValueOnce(new Error('copy_to_remote_integrity_mismatch'));

    await expect(stageBrowserUploadOnNode('node-1', '/tmp/app.aab')).rejects.toThrow(
      'copy_to_remote_integrity_mismatch',
    );
  });
});
