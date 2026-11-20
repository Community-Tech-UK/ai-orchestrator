import { describe, expect, it } from 'vitest';
import { attachmentLabels, isPlaceholderImageName } from './title-attachment-labels';

describe('made-up picture names', () => {
  it.each([
    'pasted-image-5.png', 'pasted-image-12.jpeg', 'pasted-image-3.svg+xml', 'image.png', 'image (3).png',
    'Screenshot 2026-11-19 at 10.15.03.png', 'Screenshot_20261119-101503.png', 'Screenshot (12).png',
    'Screen Shot 2020-01-02 at 09.00.00.png', 'Screenshot from 2026-11-19 10-15-03.png', 'screenshot.png',
    'CleanShot 2026-11-19 at 10.15.03@2x.png', 'IMG_1234.HEIC', 'PXL_20261119_101503123.jpg',
    '/var/folders/x/T/pasted-image-5.png', 'pasted-image-1.x-icon', 'pasted-image-2.vnd.microsoft.icon',
    'Screenshot 2026-11-19 at 10.15.03 AM.png', 'DSC01234.JPG',
    'Screenshot_2026-11-19_at_10.15.03_AM.png', 'CleanShot_2026-11-19_at_10.15.03@2x.png',
  ])('recognizes %s', (name) => {
    expect(isPlaceholderImageName(name)).toBe(true);
  });

  it.each([
    'login-page-postcode-error.png', 'screenshot-tool-design.png', 'image-cache.ts', 'imagery-plan.md',
    'imagery.png', 'image-cache.png', 'bin-day-calendar.jpg', 'screenshot from the login page.png',
    'Screenshot 3 login bug.png', 'img2txt-plan.png', 'Screenshot_final.png',
  ])('keeps the meaningful name %s', (name) => {
    expect(isPlaceholderImageName(name)).toBe(false);
  });

  it('leaves made-up picture names out of title labels', () => {
    expect(attachmentLabels(['pasted-image-5.png', 'docs/bin-day-plan.md', 'image.png'])).toEqual(['bin-day-plan.md']);
  });
});
