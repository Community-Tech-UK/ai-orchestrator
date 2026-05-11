import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_EXTENSIONS,
  artifactCategory,
  getFileExtension,
  isArtifactPath,
} from '../artifact-extensions';

describe('artifact-extensions', () => {
  describe('getFileExtension', () => {
    it('returns the lowercase extension without a dot', () => {
      expect(getFileExtension('foo.md')).toBe('md');
      expect(getFileExtension('Foo.MD')).toBe('md');
      expect(getFileExtension('PLAN.MARKDOWN')).toBe('markdown');
    });

    it('handles nested paths (POSIX and Windows)', () => {
      expect(getFileExtension('src/foo.md')).toBe('md');
      expect(getFileExtension('a/b/c.docx')).toBe('docx');
      expect(getFileExtension('C:\\Users\\me\\foo.pdf')).toBe('pdf');
    });

    it('returns "" for paths with no extension', () => {
      expect(getFileExtension('Makefile')).toBe('');
      expect(getFileExtension('LICENSE')).toBe('');
      expect(getFileExtension('src/Makefile')).toBe('');
    });

    it('treats dotfiles without secondary extension as having no extension', () => {
      expect(getFileExtension('.env')).toBe('');
      expect(getFileExtension('.gitignore')).toBe('');
    });

    it('returns the extension after the final dot for compound names', () => {
      expect(getFileExtension('report.final.md')).toBe('md');
      expect(getFileExtension('archive.tar.gz')).toBe('gz');
    });

    it('strips query strings and fragments', () => {
      expect(getFileExtension('foo.png?v=1')).toBe('png');
      expect(getFileExtension('foo.png#frag')).toBe('png');
    });

    it('returns "" for a trailing dot', () => {
      expect(getFileExtension('foo.')).toBe('');
    });
  });

  describe('isArtifactPath', () => {
    it('matches documentation extensions', () => {
      for (const ext of ['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc']) {
        expect(isArtifactPath(`PLAN.${ext}`)).toBe(true);
      }
    });

    it('matches office extensions', () => {
      for (const ext of ['docx', 'doc', 'pdf', 'xlsx', 'pptx', 'odt']) {
        expect(isArtifactPath(`Report.${ext}`)).toBe(true);
      }
    });

    it('matches image extensions', () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'avif']) {
        expect(isArtifactPath(`logo.${ext}`)).toBe(true);
      }
    });

    it('matches data and notebook extensions', () => {
      expect(isArtifactPath('export.csv')).toBe(true);
      expect(isArtifactPath('export.tsv')).toBe(true);
      expect(isArtifactPath('analysis.ipynb')).toBe(true);
    });

    it('rejects common code/build files', () => {
      for (const path of [
        'src/foo.ts',
        'src/foo.tsx',
        'src/foo.js',
        'src/foo.jsx',
        'src/foo.py',
        'src/foo.go',
        'src/foo.rs',
        'src/foo.css',
        'package.json',
        'tsconfig.json',
        'Makefile',
      ]) {
        expect(isArtifactPath(path)).toBe(false);
      }
    });

    it('is case-insensitive on the extension', () => {
      expect(isArtifactPath('PLAN.MD')).toBe(true);
      expect(isArtifactPath('Report.PDF')).toBe(true);
    });
  });

  describe('artifactCategory', () => {
    it('classifies documentation', () => {
      expect(artifactCategory('readme.md')).toBe('doc');
      expect(artifactCategory('NOTES.txt')).toBe('doc');
    });

    it('classifies office docs', () => {
      expect(artifactCategory('Report.docx')).toBe('office');
      expect(artifactCategory('handbook.pdf')).toBe('office');
    });

    it('classifies images', () => {
      expect(artifactCategory('logo.png')).toBe('image');
      expect(artifactCategory('photo.jpeg')).toBe('image');
    });

    it('classifies data exports', () => {
      expect(artifactCategory('table.csv')).toBe('data');
    });

    it('classifies notebooks', () => {
      expect(artifactCategory('analysis.ipynb')).toBe('notebook');
    });

    it('returns null for non-artifact paths', () => {
      expect(artifactCategory('src/foo.ts')).toBeNull();
      expect(artifactCategory('Makefile')).toBeNull();
    });
  });

  describe('ARTIFACT_EXTENSIONS set', () => {
    it('exposes a non-empty readonly set', () => {
      expect(ARTIFACT_EXTENSIONS.has('md')).toBe(true);
      expect(ARTIFACT_EXTENSIONS.size).toBeGreaterThan(10);
    });
  });
});
