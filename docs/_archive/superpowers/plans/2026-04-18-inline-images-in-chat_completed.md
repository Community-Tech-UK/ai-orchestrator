# Inline Images in Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Complete on 2026-04-21.
**Completion note:** The checkbox blocks below are preserved as historical implementation instructions. The feature work is now landed and verified in-repo.
**Verified on 2026-04-21:** image extractor/resolver/cache/store specs passed; `npx tsc --noEmit`; `npx tsc --noEmit -p tsconfig.spec.json`; `npm run lint`; `npm run test`; `npm run rebuild:native`; CSP remains `img-src 'self' data: blob:`.

## Completion Checklist

- [x] Contracts and IPC channel for image resolution added.
- [x] Main-process `ImageResolver` supports local files, HTTPS fetches, data URIs, SVG sanitization, and filesystem-backed caching.
- [x] Renderer extractor and `ImageAttachmentService` resolve finalized assistant-message image references.
- [x] `InstanceOutputStore` appends attachments/failures and marks messages as `imagesResolved`.
- [x] Failed image references render through `app-failed-image-card`.
- [x] Automated verification passed on 2026-04-21.

**Goal:** Make images referenced in assistant CLI output (markdown `![alt](src)`, bare image URLs, bare local file paths) appear as thumbnails beneath the assistant message, with click-to-lightbox behavior. Supports three source kinds: local file paths, https URLs (e.g., fal.media), and `data:` URIs.

**Architecture:** Renderer-side pure extractor scans finalized assistant messages for image references. New main-process service `ImageResolver` fetches/reads each reference, sanitizes SVGs, caches remote results, and returns a base64 data URL packaged as a `FileAttachment`. A new renderer effect-driven service `ImageAttachmentService` wires the extractor to the IPC resolver and appends results to `OutputMessage.attachments` via a new `InstanceOutputStore.appendAttachmentsToMessage` method. Existing `MessageAttachmentsComponent` renders the thumbnails and lightbox — no changes to CSP, markdown renderer, or the attachments UI. Failed resolutions render a small fallback card so silent drops don't mask bugs.

**Tech Stack:** Angular 21 (zoneless, signals), Electron 40, TypeScript 5.9, Zod 4, Vitest, `isomorphic-dompurify` (new dev dep for main-process SVG sanitization), better-sqlite3 (unused — cache is FS-based).

---

## File Structure

**New files:**
- `src/renderer/app/features/instance-detail/image-reference-extractor.ts` — pure function, extracts image references from text.
- `src/renderer/app/features/instance-detail/image-reference-extractor.spec.ts` — unit tests.
- `src/renderer/app/features/instance-detail/image-attachment.service.ts` — Angular service, runs extractor + calls IPC + updates store.
- `src/renderer/app/features/instance-detail/image-attachment.service.spec.ts` — unit tests.
- `src/renderer/app/shared/components/failed-image-card/failed-image-card.component.ts` — fallback UI for failed resolutions.
- `src/main/services/image-resolver.ts` — singleton service, resolves image references to `FileAttachment`.
- `src/main/services/image-resolver.spec.ts` — unit tests.
- `src/main/services/image-cache.ts` — content-addressed FS cache for remote images.
- `src/main/services/image-cache.spec.ts` — unit tests.
- `packages/contracts/src/schemas/image.schemas.ts` — Zod request/response schemas.

**Modified files:**
- `packages/contracts/src/channels/file.channels.ts` — add `IMAGE_RESOLVE: 'image:resolve'` constant.
- `src/main/ipc/handlers/image-handlers.ts` — add `IMAGE_RESOLVE` handler that delegates to `ImageResolver`.
- `src/preload/domains/file.preload.ts` — add `imageResolve(payload)` method.
- `src/renderer/app/core/services/ipc/file-ipc.service.ts` — add `resolveImage(...)` wrapper method.
- `src/renderer/app/core/state/instance/instance-output.store.ts` — add `appendAttachmentsToMessage(instanceId, messageId, attachments, failures)` and `markImagesResolved(instanceId, messageId)` methods.
- `src/renderer/app/core/state/instance/instance.types.ts` — add `failedImages?: FailedImageRef[]` to `OutputMessage`.
- `src/shared/types/instance.types.ts` — same `failedImages?` addition to the shared `OutputMessage`.
- `src/renderer/app/features/instance-detail/output-stream.component.ts` — render `<app-failed-image-card>` after `<app-message-attachments>` for assistant messages.
- `src/main/index.ts` — initialize `ImageResolver` singleton (if other singletons are initialized there; otherwise rely on lazy init).
- `package.json` — add `isomorphic-dompurify` as a dependency (main-process runtime).

---

## Shared types referenced throughout

Defined in `packages/contracts/src/schemas/image.schemas.ts` (Task 2):

```typescript
export type ImageResolveKind = 'local' | 'remote' | 'data';

export interface ImageResolveRequest {
  kind: ImageResolveKind;
  src: string;
  alt?: string;
}

export type ImageResolveFailureReason =
  | 'too_large'
  | 'not_found'
  | 'denied'
  | 'fetch_failed'
  | 'unsupported'
  | 'timeout'
  | 'invalid_data_uri';

export interface ImageResolveSuccess {
  ok: true;
  attachment: FileAttachment; // from src/shared/types/instance.types.ts
}

export interface ImageResolveFailure {
  ok: false;
  reason: ImageResolveFailureReason;
  message: string;
}

export type ImageResolveResponse = ImageResolveSuccess | ImageResolveFailure;
```

And in `src/shared/types/instance.types.ts` (Task 11):

```typescript
export interface FailedImageRef {
  /** Original src as written by the AI (URL, path, or data URI). */
  src: string;
  kind: ImageResolveKind;
  reason: ImageResolveFailureReason;
  message: string;
}
```

Constants:
- `MAX_IMAGE_BYTES = 10 * 1024 * 1024` (10 MB) — per image.
- `REMOTE_FETCH_TIMEOUT_MS = 10_000` (10 s).
- `CACHE_MAX_BYTES = 200 * 1024 * 1024` (200 MB) — total cache size.
- `ALLOWED_IMAGE_EXTENSIONS = ['.png','.jpg','.jpeg','.gif','.webp','.svg','.avif']`.

Define these in a new file `src/main/services/image-constants.ts` (created in Task 6) and reuse across main-process tasks.

---

## Task 1: Add IPC channel constant

**Files:**
- Modify: `packages/contracts/src/channels/file.channels.ts:37-40`
- Test: `packages/contracts/src/channels/__tests__/file.channels.spec.ts`

- [ ] **Step 1: Add `IMAGE_RESOLVE` constant**

Edit `packages/contracts/src/channels/file.channels.ts`. Replace the "Image operations" block with:

```typescript
  // Image operations
  IMAGE_PASTE: 'image:paste',
  IMAGE_COPY_TO_CLIPBOARD: 'image:copy-to-clipboard',
  IMAGE_CONTEXT_MENU: 'image:context-menu',
  IMAGE_RESOLVE: 'image:resolve',
```

- [ ] **Step 2: Add to existing channel spec**

Edit `packages/contracts/src/channels/__tests__/file.channels.spec.ts`. Add an assertion inside the existing describe block:

```typescript
it('exposes the IMAGE_RESOLVE channel', () => {
  expect(FILE_CHANNELS.IMAGE_RESOLVE).toBe('image:resolve');
});
```

- [ ] **Step 3: Run test**

Run: `npx vitest run packages/contracts/src/channels/__tests__/file.channels.spec.ts`
Expected: PASS.

- [ ] **Step 4: Regenerate preload channel types**

Run: `npm run prebuild` (this runs `scripts/generate-preload-channels.js` per package.json scripts, if wired; otherwise the next `npm run dev` regenerates `src/preload/generated/channels.ts`).

Verify: `src/preload/generated/channels.ts` now includes `IMAGE_RESOLVE: 'image:resolve'`.

If the generated file is not auto-regenerated, manually add the entry alongside the other image channels.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/channels/file.channels.ts packages/contracts/src/channels/__tests__/file.channels.spec.ts src/preload/generated/channels.ts
git commit -m "feat(ipc): add IMAGE_RESOLVE channel for inline image resolution"
```

---

## Task 2: Zod schemas and shared types

**Files:**
- Create: `packages/contracts/src/schemas/image.schemas.ts`
- Modify: `packages/contracts/src/index.ts` — re-export new schemas.
- Modify: `src/shared/types/instance.types.ts:145-164` — add `failedImages` to `OutputMessage`.
- Modify: `src/renderer/app/core/state/instance/instance.types.ts:56-68` — mirror `failedImages` field.
- Test: `packages/contracts/src/schemas/__tests__/image.schemas.spec.ts`

- [ ] **Step 1: Create the schema file**

Write `packages/contracts/src/schemas/image.schemas.ts`:

```typescript
import { z } from 'zod';

export const ImageResolveKindSchema = z.enum(['local', 'remote', 'data']);
export type ImageResolveKind = z.infer<typeof ImageResolveKindSchema>;

export const ImageResolveRequestSchema = z.object({
  kind: ImageResolveKindSchema,
  src: z.string().min(1).max(8192),
  alt: z.string().max(256).optional(),
});
export type ImageResolveRequest = z.infer<typeof ImageResolveRequestSchema>;

export const ImageResolveFailureReasonSchema = z.enum([
  'too_large',
  'not_found',
  'denied',
  'fetch_failed',
  'unsupported',
  'timeout',
  'invalid_data_uri',
]);
export type ImageResolveFailureReason = z.infer<typeof ImageResolveFailureReasonSchema>;

/**
 * FileAttachment shape (mirrored here to keep the contracts package self-contained).
 * Must stay in sync with src/shared/types/instance.types.ts FileAttachment.
 */
export const FileAttachmentSchema = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number().int().nonnegative(),
  data: z.string(), // base64 data URL
});

export const ImageResolveResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), attachment: FileAttachmentSchema }),
  z.object({
    ok: z.literal(false),
    reason: ImageResolveFailureReasonSchema,
    message: z.string(),
  }),
]);
export type ImageResolveResponse = z.infer<typeof ImageResolveResponseSchema>;
```

- [ ] **Step 2: Re-export from contracts index**

Edit `packages/contracts/src/index.ts` (check existing exports pattern). Add:

```typescript
export * from './schemas/image.schemas';
```

Place this line alongside the other `export * from './schemas/...'` lines.

- [ ] **Step 3: Add `failedImages` field to shared OutputMessage**

Edit `src/shared/types/instance.types.ts`. After `FileAttachment` interface (around line 164), add:

```typescript
export type ImageResolveKind = 'local' | 'remote' | 'data';

export type ImageResolveFailureReason =
  | 'too_large'
  | 'not_found'
  | 'denied'
  | 'fetch_failed'
  | 'unsupported'
  | 'timeout'
  | 'invalid_data_uri';

export interface FailedImageRef {
  src: string;
  kind: ImageResolveKind;
  reason: ImageResolveFailureReason;
  message: string;
}
```

Then edit the `OutputMessage` interface (line 145-157) to add:

```typescript
export interface OutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  /** File attachments for user messages */
  attachments?: FileAttachment[];
  /** Image references that failed to resolve for this assistant message. */
  failedImages?: FailedImageRef[];
  /** Extracted thinking/reasoning content */
  thinking?: ThinkingContent[];
  /** Whether thinking has been extracted from this message */
  thinkingExtracted?: boolean;
}
```

- [ ] **Step 4: Mirror `failedImages` in renderer OutputMessage**

Edit `src/renderer/app/core/state/instance/instance.types.ts`. The file imports `FileAttachment` from shared — add `FailedImageRef` to that import (around line 9) and add the field to the renderer-side `OutputMessage` (line 56-68):

```typescript
import type {
  FileAttachment,
  FailedImageRef,
  // …existing imports
} from '../../../../../shared/types/instance.types';
```

Then update the interface:

```typescript
export interface OutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  /** File attachments for user messages */
  attachments?: FileAttachment[];
  /** Image refs that failed to resolve (populated by ImageAttachmentService). */
  failedImages?: FailedImageRef[];
  /** Extracted thinking/reasoning content */
  thinking?: ThinkingContent[];
  /** Whether thinking has been extracted from this message */
  thinkingExtracted?: boolean;
}
```

- [ ] **Step 5: Write schema unit tests**

Write `packages/contracts/src/schemas/__tests__/image.schemas.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  ImageResolveRequestSchema,
  ImageResolveResponseSchema,
} from '../image.schemas';

describe('ImageResolveRequestSchema', () => {
  it('accepts a valid local request', () => {
    const result = ImageResolveRequestSchema.safeParse({
      kind: 'local',
      src: '/Users/test/foo.png',
    });
    expect(result.success).toBe(true);
  });

  it('accepts alt text up to 256 chars', () => {
    const result = ImageResolveRequestSchema.safeParse({
      kind: 'remote',
      src: 'https://fal.media/x.png',
      alt: 'a'.repeat(256),
    });
    expect(result.success).toBe(true);
  });

  it('rejects alt text over 256 chars', () => {
    const result = ImageResolveRequestSchema.safeParse({
      kind: 'remote',
      src: 'https://fal.media/x.png',
      alt: 'a'.repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown kinds', () => {
    const result = ImageResolveRequestSchema.safeParse({
      kind: 'ftp',
      src: 'ftp://x/y.png',
    });
    expect(result.success).toBe(false);
  });

  it('rejects src longer than 8192 chars', () => {
    const result = ImageResolveRequestSchema.safeParse({
      kind: 'data',
      src: 'data:image/png;base64,' + 'A'.repeat(9000),
    });
    expect(result.success).toBe(false);
  });
});

describe('ImageResolveResponseSchema', () => {
  it('accepts a success response', () => {
    const result = ImageResolveResponseSchema.safeParse({
      ok: true,
      attachment: {
        name: 'og.png',
        type: 'image/png',
        size: 1024,
        data: 'data:image/png;base64,AAA',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a failure response', () => {
    const result = ImageResolveResponseSchema.safeParse({
      ok: false,
      reason: 'too_large',
      message: 'File exceeds 10 MB',
    });
    expect(result.success).toBe(true);
  });

  it('rejects mixed success/failure shapes', () => {
    const result = ImageResolveResponseSchema.safeParse({
      ok: true,
      reason: 'too_large',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/contracts/src/schemas/__tests__/image.schemas.spec.ts`
Expected: PASS (all 8 assertions).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS for both.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/schemas/image.schemas.ts packages/contracts/src/schemas/__tests__/image.schemas.spec.ts packages/contracts/src/index.ts src/shared/types/instance.types.ts src/renderer/app/core/state/instance/instance.types.ts
git commit -m "feat(types): add ImageResolve schemas and FailedImageRef type"
```

---

## Task 3: Install isomorphic-dompurify and define image constants

**Files:**
- Modify: `package.json`
- Create: `src/main/services/image-constants.ts`

- [ ] **Step 1: Install isomorphic-dompurify**

Run: `npm install --save isomorphic-dompurify@^2.19.0`

This adds a Node + browser compatible DOMPurify wrapper for main-process SVG sanitization.

- [ ] **Step 2: Create constants file**

Write `src/main/services/image-constants.ts`:

```typescript
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;           // 10 MB
export const REMOTE_FETCH_TIMEOUT_MS = 10_000;             // 10 s
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;          // 200 MB
export const ALLOWED_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
] as const;

export const EXTENSION_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

export function extensionForMime(mime: string): string | undefined {
  const normalized = mime.toLowerCase().split(';')[0].trim();
  switch (normalized) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/svg+xml': return '.svg';
    case 'image/avif': return '.avif';
    default: return undefined;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/main/services/image-constants.ts
git commit -m "chore: add isomorphic-dompurify and image-constants for inline image resolver"
```

---

## Task 4: Create `extractImageReferences` pure function

**Files:**
- Create: `src/renderer/app/features/instance-detail/image-reference-extractor.ts`
- Test: `src/renderer/app/features/instance-detail/image-reference-extractor.spec.ts`

- [ ] **Step 1: Write the failing test file**

Write `src/renderer/app/features/instance-detail/image-reference-extractor.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractImageReferences, ImageReference } from './image-reference-extractor';

describe('extractImageReferences', () => {
  it('returns empty array for text with no images', () => {
    expect(extractImageReferences('hello world')).toEqual([]);
  });

  describe('markdown image syntax', () => {
    it('extracts a markdown image with an http URL', () => {
      const refs = extractImageReferences('here ![og](https://fal.media/x.png)');
      expect(refs).toEqual([{
        kind: 'remote',
        raw: '![og](https://fal.media/x.png)',
        src: 'https://fal.media/x.png',
        alt: 'og',
      }]);
    });

    it('extracts a markdown image with a data URI', () => {
      const refs = extractImageReferences('![x](data:image/png;base64,AAAA)');
      expect(refs[0]).toMatchObject({
        kind: 'data',
        src: 'data:image/png;base64,AAAA',
        alt: 'x',
      });
    });

    it('extracts a markdown image with an absolute local path', () => {
      const refs = extractImageReferences('![og](/Users/suas/og.png)');
      expect(refs[0]).toMatchObject({
        kind: 'local',
        src: '/Users/suas/og.png',
        alt: 'og',
      });
    });

    it('extracts a markdown image with a file:// URL', () => {
      const refs = extractImageReferences('![og](file:///Users/suas/og.png)');
      expect(refs[0]).toMatchObject({
        kind: 'local',
        src: '/Users/suas/og.png',
      });
    });

    it('handles empty alt text', () => {
      const refs = extractImageReferences('![](https://fal.media/x.png)');
      expect(refs[0]).toMatchObject({
        kind: 'remote',
        src: 'https://fal.media/x.png',
        alt: '',
      });
    });
  });

  describe('bare URLs and paths', () => {
    it('extracts a bare https URL ending in .png', () => {
      const refs = extractImageReferences('here it is:\nhttps://v3.fal.media/x.webp');
      expect(refs[0]).toMatchObject({
        kind: 'remote',
        src: 'https://v3.fal.media/x.webp',
      });
    });

    it('extracts a bare absolute local path', () => {
      const refs = extractImageReferences('see /Users/suas/Downloads/shot.png');
      expect(refs[0]).toMatchObject({
        kind: 'local',
        src: '/Users/suas/Downloads/shot.png',
      });
    });

    it('does not extract URLs with non-image extensions', () => {
      expect(extractImageReferences('https://example.com/file.zip')).toEqual([]);
    });

    it('does not extract bare paths without an extension', () => {
      expect(extractImageReferences('see /etc/passwd')).toEqual([]);
    });

    it('does not extract bare paths that are not absolute', () => {
      expect(extractImageReferences('see ./relative.png')).toEqual([]);
    });

    it('does not false-positive on path-looking substrings inside a word', () => {
      // "/Users/x.png" preceded by non-whitespace should not match
      expect(extractImageReferences('foo/Users/x.png bar')).toEqual([]);
    });
  });

  describe('precedence and dedupe', () => {
    it('picks markdown form over bare form when both could match', () => {
      const refs = extractImageReferences('![](https://fal.media/x.png)');
      expect(refs).toHaveLength(1);
      expect(refs[0].raw).toBe('![](https://fal.media/x.png)');
    });

    it('deduplicates identical srcs, keeping first occurrence', () => {
      const refs = extractImageReferences(
        '![a](https://fal.media/x.png) and again ![b](https://fal.media/x.png)'
      );
      expect(refs).toHaveLength(1);
      expect(refs[0].alt).toBe('a');
    });

    it('preserves source order across kinds', () => {
      const refs = extractImageReferences(
        'one https://fal.media/a.png\ntwo /Users/suas/b.png\nthree ![c](data:image/png;base64,AAA)'
      );
      expect(refs.map(r => r.kind)).toEqual(['remote', 'local', 'data']);
    });
  });

  describe('extension handling', () => {
    it('is case-insensitive for extensions', () => {
      const refs = extractImageReferences('https://fal.media/X.PNG');
      expect(refs[0]).toMatchObject({ kind: 'remote', src: 'https://fal.media/X.PNG' });
    });

    it('accepts all allowed extensions', () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']) {
        const refs = extractImageReferences(`https://x.com/img.${ext}`);
        expect(refs, ext).toHaveLength(1);
      }
    });

    it('rejects non-image extensions', () => {
      expect(extractImageReferences('https://x.com/img.bmp')).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('handles markdown images with query strings', () => {
      const refs = extractImageReferences('![og](https://fal.media/x.png?v=1)');
      expect(refs[0]).toMatchObject({
        kind: 'remote',
        src: 'https://fal.media/x.png?v=1',
      });
    });

    it('does not match http (non-https) bare URLs', () => {
      // Markdown form for http is still allowed; bare http is rejected to stay in line with
      // the resolver's https-only policy. Avoids surfacing fails.
      expect(extractImageReferences('http://example.com/x.png')).toEqual([]);
    });

    it('matches http inside markdown syntax (resolver will reject it)', () => {
      const refs = extractImageReferences('![x](http://example.com/x.png)');
      expect(refs).toHaveLength(1);
      expect(refs[0].kind).toBe('remote');
    });
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `npx vitest run src/renderer/app/features/instance-detail/image-reference-extractor.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the extractor**

Write `src/renderer/app/features/instance-detail/image-reference-extractor.ts`:

```typescript
export interface ImageReference {
  kind: 'local' | 'remote' | 'data';
  raw: string;
  src: string;
  alt?: string;
}

const IMAGE_EXT = '(?:png|jpe?g|gif|webp|svg|avif)';

/**
 * Markdown image syntax: ![alt](src)
 *
 * - `alt`: captured group 1, may be empty.
 * - `src`: captured group 2. We match non-greedy up to the first closing paren,
 *   which means URLs containing `)` cannot be matched (rare for image URLs;
 *   users can rewrite them if they hit this).
 */
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Bare https URL ending in image extension, bounded by whitespace or start/end.
 * Uses a lookbehind for whitespace/start to avoid false positives inside words.
 */
const BARE_REMOTE_RE = new RegExp(
  `(?:^|(?<=\\s))(https://[^\\s)]+\\.${IMAGE_EXT})(?:[?#][^\\s)]*)?(?=$|\\s|[.,!?;:])`,
  'gi'
);

/**
 * Bare absolute local path ending in image extension.
 * Starts with "/" preceded by whitespace/start, no spaces in the path.
 */
const BARE_LOCAL_RE = new RegExp(
  `(?:^|(?<=\\s))(/[^\\s]+\\.${IMAGE_EXT})(?=$|\\s|[.,!?;:])`,
  'gi'
);

function classifySrc(src: string): 'local' | 'remote' | 'data' {
  if (src.startsWith('data:')) return 'data';
  if (src.startsWith('file://')) return 'local';
  if (src.startsWith('/')) return 'local';
  if (src.startsWith('http://') || src.startsWith('https://')) return 'remote';
  // Fallback — any non-absolute path is rejected upstream; this keeps the type exhaustive.
  return 'remote';
}

function normalizeLocalPath(src: string): string {
  if (src.startsWith('file://')) {
    // file:///Users/... → /Users/...
    return decodeURI(src.slice('file://'.length));
  }
  return src;
}

export function extractImageReferences(text: string): ImageReference[] {
  if (!text) return [];

  const markdownRanges: Array<[number, number]> = [];
  const refs: ImageReference[] = [];
  const seen = new Set<string>();

  // 1. Markdown images (highest precedence).
  MD_IMAGE_RE.lastIndex = 0;
  for (const match of text.matchAll(MD_IMAGE_RE)) {
    if (match.index == null) continue;
    const alt = match[1];
    const rawSrc = match[2];
    const kind = classifySrc(rawSrc);
    const src = kind === 'local' ? normalizeLocalPath(rawSrc) : rawSrc;

    markdownRanges.push([match.index, match.index + match[0].length]);

    if (seen.has(src)) continue;
    seen.add(src);
    refs.push({ kind, raw: match[0], src, alt });
  }

  const inMarkdownRange = (index: number): boolean =>
    markdownRanges.some(([start, end]) => index >= start && index < end);

  // 2. Bare https URLs.
  BARE_REMOTE_RE.lastIndex = 0;
  for (const match of text.matchAll(BARE_REMOTE_RE)) {
    if (match.index == null) continue;
    if (inMarkdownRange(match.index)) continue;
    const src = match[1];
    if (seen.has(src)) continue;
    seen.add(src);
    refs.push({ kind: 'remote', raw: src, src });
  }

  // 3. Bare absolute local paths.
  BARE_LOCAL_RE.lastIndex = 0;
  for (const match of text.matchAll(BARE_LOCAL_RE)) {
    if (match.index == null) continue;
    if (inMarkdownRange(match.index)) continue;
    const src = match[1];
    if (seen.has(src)) continue;
    seen.add(src);
    refs.push({ kind: 'local', raw: src, src });
  }

  // Preserve original source order.
  refs.sort((a, b) => text.indexOf(a.raw) - text.indexOf(b.raw));
  return refs;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `npx vitest run src/renderer/app/features/instance-detail/image-reference-extractor.spec.ts`
Expected: PASS — all test cases green.

If any fail, read the failures and fix the regex boundaries. Common issue: `(?<=\s)` lookbehind behavior at string start — the `(?:^|(?<=\s))` construct should handle it, but if Node's regex engine rejects it, fall back to a manual start-position check.

- [ ] **Step 5: Typecheck both configs**

Run: `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/features/instance-detail/image-reference-extractor.ts src/renderer/app/features/instance-detail/image-reference-extractor.spec.ts
git commit -m "feat(chat): add ImageReferenceExtractor for markdown + bare image refs"
```

---

## Task 5: Main-process ImageResolver — local file resolution

**Files:**
- Create: `src/main/services/image-resolver.ts`
- Test: `src/main/services/image-resolver.spec.ts`

- [ ] **Step 1: Write the failing test file**

Write `src/main/services/image-resolver.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImageResolver } from './image-resolver';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return os.homedir();
      if (name === 'temp') return os.tmpdir();
      if (name === 'userData') return path.join(os.tmpdir(), 'ai-orchestrator-test-userdata');
      throw new Error(`unknown path: ${name}`);
    },
  },
}));

function pngFixture(): Buffer {
  // Minimal valid PNG (1x1 transparent pixel)
  return Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CFC0500F0000030101007A3CCF3E0000000049454E44AE426082',
    'hex'
  );
}

describe('ImageResolver.resolveLocal', () => {
  let tempDir: string;
  let resolver: ImageResolver;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'img-resolver-'));
    resolver = new ImageResolver({ projectRoots: [tempDir] });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves an allowlisted PNG to a FileAttachment', async () => {
    const fixturePath = path.join(tempDir, 'og.png');
    await fs.writeFile(fixturePath, pngFixture());

    const result = await resolver.resolve({ kind: 'local', src: fixturePath });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachment.name).toBe('og.png');
      expect(result.attachment.type).toBe('image/png');
      expect(result.attachment.size).toBeGreaterThan(0);
      expect(result.attachment.data).toMatch(/^data:image\/png;base64,/);
    }
  });

  it('returns denied for paths outside allowlisted roots', async () => {
    // /etc/ is not under home, temp, userData, or projectRoots.
    const result = await resolver.resolve({ kind: 'local', src: '/etc/hosts' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('denied');
    }
  });

  it('returns not_found for non-existent paths under an allowed root', async () => {
    const result = await resolver.resolve({
      kind: 'local',
      src: path.join(tempDir, 'does-not-exist.png'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });

  it('returns unsupported for non-image extensions under an allowed root', async () => {
    const binPath = path.join(tempDir, 'script.sh');
    await fs.writeFile(binPath, '#!/bin/sh\necho hi\n');

    const result = await resolver.resolve({ kind: 'local', src: binPath });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported');
    }
  });

  it('returns too_large when the file exceeds MAX_IMAGE_BYTES', async () => {
    const bigPath = path.join(tempDir, 'big.png');
    // Write 11 MB of zeros.
    await fs.writeFile(bigPath, Buffer.alloc(11 * 1024 * 1024));

    const result = await resolver.resolve({ kind: 'local', src: bigPath });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too_large');
    }
  });

  it('decodes file:// URLs before reading', async () => {
    const fixturePath = path.join(tempDir, 'og.png');
    await fs.writeFile(fixturePath, pngFixture());

    const result = await resolver.resolve({
      kind: 'local',
      src: `file://${fixturePath}`,
    });

    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `npx vitest run src/main/services/image-resolver.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement local resolution**

Write `src/main/services/image-resolver.ts`:

```typescript
import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  FileAttachment,
} from '../../shared/types/instance.types';
import type {
  ImageResolveRequest,
  ImageResolveResponse,
  ImageResolveFailureReason,
} from '../../../packages/contracts/src/schemas/image.schemas';
import {
  ALLOWED_IMAGE_EXTENSIONS,
  EXTENSION_TO_MIME,
  MAX_IMAGE_BYTES,
} from './image-constants';
import { getLogger } from '../logging/logger';

const logger = getLogger('ImageResolver');

export interface ImageResolverOptions {
  /** Additional allowlisted roots (e.g., project working directories). */
  projectRoots?: string[];
}

function fail(reason: ImageResolveFailureReason, message: string): ImageResolveResponse {
  return { ok: false, reason, message };
}

function decodeFileUrl(src: string): string {
  if (src.startsWith('file://')) {
    return decodeURI(src.slice('file://'.length));
  }
  return src;
}

export class ImageResolver {
  private projectRoots: string[];

  constructor(options: ImageResolverOptions = {}) {
    this.projectRoots = options.projectRoots ?? [];
  }

  addProjectRoot(root: string): void {
    if (!this.projectRoots.includes(root)) {
      this.projectRoots.push(root);
    }
  }

  private allowedRoots(): string[] {
    const roots: string[] = [];
    try { roots.push(app.getPath('home')); } catch { /* unavailable in some tests */ }
    try { roots.push(app.getPath('temp')); } catch { /* unavailable */ }
    try { roots.push(app.getPath('userData')); } catch { /* unavailable */ }
    roots.push(...this.projectRoots);
    return roots
      .map((r) => path.resolve(r))
      .filter((r, i, arr) => arr.indexOf(r) === i);
  }

  private isUnderAllowedRoot(absPath: string): boolean {
    const resolved = path.resolve(absPath);
    return this.allowedRoots().some((root) => {
      const rel = path.relative(root, resolved);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  async resolve(req: ImageResolveRequest): Promise<ImageResolveResponse> {
    try {
      if (req.kind === 'local') return await this.resolveLocal(req.src);
      if (req.kind === 'remote') return await this.resolveRemote(req.src);
      if (req.kind === 'data') return await this.resolveData(req.src);
      return fail('unsupported', `Unknown kind: ${req.kind}`);
    } catch (error) {
      logger.error('resolve threw', error instanceof Error ? error : undefined);
      return fail('fetch_failed', error instanceof Error ? error.message : String(error));
    }
  }

  private async resolveLocal(srcInput: string): Promise<ImageResolveResponse> {
    const absPath = path.resolve(decodeFileUrl(srcInput));

    if (!this.isUnderAllowedRoot(absPath)) {
      return fail('denied', `Path is outside allowed roots: ${absPath}`);
    }

    const ext = path.extname(absPath).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext as typeof ALLOWED_IMAGE_EXTENSIONS[number])) {
      return fail('unsupported', `Unsupported extension: ${ext}`);
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return fail('not_found', `File not found: ${absPath}`);
      }
      throw err;
    }

    if (stat.size > MAX_IMAGE_BYTES) {
      return fail(
        'too_large',
        `File is ${stat.size} bytes, exceeds max ${MAX_IMAGE_BYTES}`
      );
    }

    const buffer = await fs.readFile(absPath);
    const mime = EXTENSION_TO_MIME[ext] ?? 'application/octet-stream';

    // SVG sanitization happens in Task 7.
    const data = `data:${mime};base64,${buffer.toString('base64')}`;

    const attachment: FileAttachment = {
      name: path.basename(absPath),
      type: mime,
      size: stat.size,
      data,
    };

    return { ok: true, attachment };
  }

  private async resolveRemote(_src: string): Promise<ImageResolveResponse> {
    return fail('unsupported', 'Remote resolution not yet implemented');
  }

  private async resolveData(_src: string): Promise<ImageResolveResponse> {
    return fail('unsupported', 'Data URI resolution not yet implemented');
  }
}

let instance: ImageResolver | null = null;
export function getImageResolver(): ImageResolver {
  if (!instance) instance = new ImageResolver();
  return instance;
}
export function _resetImageResolverForTesting(): void {
  instance = null;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `npx vitest run src/main/services/image-resolver.spec.ts`
Expected: PASS — all 6 local-resolution cases green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.electron.json` and `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/image-resolver.ts src/main/services/image-resolver.spec.ts
git commit -m "feat(main): ImageResolver local-file resolution with allowlisted roots"
```

---

## Task 6: ImageResolver — remote URL resolution + cache

**Files:**
- Create: `src/main/services/image-cache.ts`
- Test: `src/main/services/image-cache.spec.ts`
- Modify: `src/main/services/image-resolver.ts` (replace `resolveRemote` stub)
- Modify: `src/main/services/image-resolver.spec.ts` (add remote test cases)

- [ ] **Step 1: Write failing tests for ImageCache**

Write `src/main/services/image-cache.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImageCache } from './image-cache';

describe('ImageCache', () => {
  let tempDir: string;
  let cache: ImageCache;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'img-cache-'));
    cache = new ImageCache({ rootDir: tempDir, maxBytes: 1024 });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns undefined on miss', async () => {
    expect(await cache.get('https://fal.media/x.png')).toBeUndefined();
  });

  it('stores and retrieves an entry', async () => {
    const buf = Buffer.from('abcdef');
    await cache.put('https://fal.media/x.png', buf, 'image/png');

    const entry = await cache.get('https://fal.media/x.png');
    expect(entry).toBeDefined();
    expect(entry!.buffer.equals(buf)).toBe(true);
    expect(entry!.mime).toBe('image/png');
  });

  it('evicts least-recently-used entries when over maxBytes', async () => {
    // 400 bytes each → three entries exceed 1024-byte cap, oldest should go.
    await cache.put('url-a', Buffer.alloc(400), 'image/png');
    await new Promise((r) => setTimeout(r, 5));
    await cache.put('url-b', Buffer.alloc(400), 'image/png');
    await new Promise((r) => setTimeout(r, 5));
    // Touch url-a so url-b is now least recently used.
    await cache.get('url-a');
    await new Promise((r) => setTimeout(r, 5));
    await cache.put('url-c', Buffer.alloc(400), 'image/png');

    expect(await cache.get('url-a')).toBeDefined();
    expect(await cache.get('url-c')).toBeDefined();
    expect(await cache.get('url-b')).toBeUndefined();
  });

  it('survives a re-open by reading sidecar metadata', async () => {
    await cache.put('url-a', Buffer.from('hello'), 'image/png');

    const reopened = new ImageCache({ rootDir: tempDir, maxBytes: 1024 });
    const entry = await reopened.get('url-a');
    expect(entry?.buffer.toString()).toBe('hello');
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `npx vitest run src/main/services/image-cache.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the cache**

Write `src/main/services/image-cache.ts`:

```typescript
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CACHE_MAX_BYTES } from './image-constants';
import { getLogger } from '../logging/logger';

const logger = getLogger('ImageCache');

interface CacheEntryMeta {
  key: string;
  mime: string;
  size: number;
  lastAccess: number;
}

export interface CacheEntry {
  buffer: Buffer;
  mime: string;
}

export interface ImageCacheOptions {
  rootDir: string;
  maxBytes?: number;
}

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export class ImageCache {
  private rootDir: string;
  private maxBytes: number;
  private index: Map<string, CacheEntryMeta> = new Map();
  private ready: Promise<void>;

  constructor(options: ImageCacheOptions) {
    this.rootDir = options.rootDir;
    this.maxBytes = options.maxBytes ?? CACHE_MAX_BYTES;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      await fs.mkdir(this.rootDir, { recursive: true });
      const entries = await fs.readdir(this.rootDir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const metaPath = path.join(this.rootDir, entry);
          const raw = await fs.readFile(metaPath, 'utf8');
          const meta = JSON.parse(raw) as CacheEntryMeta;
          this.index.set(meta.key, meta);
        } catch (err) {
          logger.warn(`Failed to load cache entry ${entry}`);
        }
      }
    } catch (err) {
      logger.error('Cache init failed', err instanceof Error ? err : undefined);
    }
  }

  private dataPath(key: string): string {
    return path.join(this.rootDir, `${hashKey(key)}.bin`);
  }

  private metaPath(key: string): string {
    return path.join(this.rootDir, `${hashKey(key)}.json`);
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    await this.ready;
    const meta = this.index.get(key);
    if (!meta) return undefined;
    try {
      const buffer = await fs.readFile(this.dataPath(key));
      meta.lastAccess = Date.now();
      await fs.writeFile(this.metaPath(key), JSON.stringify(meta));
      return { buffer, mime: meta.mime };
    } catch {
      this.index.delete(key);
      return undefined;
    }
  }

  async put(key: string, buffer: Buffer, mime: string): Promise<void> {
    await this.ready;
    const meta: CacheEntryMeta = {
      key,
      mime,
      size: buffer.byteLength,
      lastAccess: Date.now(),
    };
    await fs.writeFile(this.dataPath(key), buffer);
    await fs.writeFile(this.metaPath(key), JSON.stringify(meta));
    this.index.set(key, meta);
    await this.evictIfNeeded();
  }

  private totalBytes(): number {
    let total = 0;
    for (const meta of this.index.values()) total += meta.size;
    return total;
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.totalBytes() > this.maxBytes && this.index.size > 0) {
      let oldestKey: string | undefined;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, meta] of this.index.entries()) {
        if (meta.lastAccess < oldestTime) {
          oldestTime = meta.lastAccess;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.index.delete(oldestKey);
      try {
        await fs.unlink(this.dataPath(oldestKey));
        await fs.unlink(this.metaPath(oldestKey));
      } catch {
        // Entry may already be gone — fine.
      }
    }
  }
}
```

- [ ] **Step 4: Run cache tests (expect pass)**

Run: `npx vitest run src/main/services/image-cache.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add remote-resolution tests to resolver spec**

Append to `src/main/services/image-resolver.spec.ts`:

```typescript
describe('ImageResolver.resolveRemote', () => {
  let resolver: ImageResolver;

  beforeEach(() => {
    resolver = new ImageResolver();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects http (non-https) URLs', async () => {
    const result = await resolver.resolve({
      kind: 'remote',
      src: 'http://example.com/x.png',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('denied');
  });

  it('fetches an https image and returns a FileAttachment', async () => {
    const pngBytes = pngFixture();
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'image/png',
        'content-length': String(pngBytes.length),
      }),
      arrayBuffer: async () => pngBytes.buffer.slice(
        pngBytes.byteOffset,
        pngBytes.byteOffset + pngBytes.byteLength
      ),
    });

    const result = await resolver.resolve({
      kind: 'remote',
      src: 'https://fal.media/x.png',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachment.type).toBe('image/png');
      expect(result.attachment.data).toMatch(/^data:image\/png;base64,/);
    }
  });

  it('returns too_large when content-length exceeds cap', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'image/png',
        'content-length': String(11 * 1024 * 1024),
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const result = await resolver.resolve({
      kind: 'remote',
      src: 'https://fal.media/big.png',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_large');
  });

  it('returns unsupported when content-type is not an image', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'text/html',
        'content-length': '100',
      }),
      arrayBuffer: async () => new ArrayBuffer(100),
    });

    const result = await resolver.resolve({
      kind: 'remote',
      src: 'https://example.com/not-an-image',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported');
  });

  it('returns fetch_failed on non-2xx status', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const result = await resolver.resolve({
      kind: 'remote',
      src: 'https://example.com/missing.png',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('fetch_failed');
  });

  it('returns timeout when fetch aborts', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_url: string, init?: { signal?: AbortSignal }) => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    );

    const result = await resolver.resolve({
      kind: 'remote',
      src: 'https://slow.example.com/x.png',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
  });
});
```

- [ ] **Step 6: Run resolver tests (expect failure for new cases)**

Run: `npx vitest run src/main/services/image-resolver.spec.ts`
Expected: Local tests PASS; remote tests FAIL (stub still returns `unsupported`).

- [ ] **Step 7: Implement `resolveRemote`**

Edit `src/main/services/image-resolver.ts`. At the top of the file, add imports:

```typescript
import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ImageCache } from './image-cache';
import {
  ALLOWED_IMAGE_EXTENSIONS,
  CACHE_MAX_BYTES,
  EXTENSION_TO_MIME,
  MAX_IMAGE_BYTES,
  REMOTE_FETCH_TIMEOUT_MS,
  extensionForMime,
} from './image-constants';
```

Replace the constructor and add cache field:

```typescript
export class ImageResolver {
  private projectRoots: string[];
  private cache: ImageCache | null = null;

  constructor(options: ImageResolverOptions = {}) {
    this.projectRoots = options.projectRoots ?? [];
  }

  private getCache(): ImageCache {
    if (!this.cache) {
      let rootDir: string;
      try {
        rootDir = path.join(app.getPath('userData'), 'media-cache');
      } catch {
        rootDir = path.join(require('node:os').tmpdir(), 'ai-orchestrator-media-cache');
      }
      this.cache = new ImageCache({ rootDir, maxBytes: CACHE_MAX_BYTES });
    }
    return this.cache;
  }
  // ...existing methods
}
```

Replace the `resolveRemote` stub with:

```typescript
private async resolveRemote(src: string): Promise<ImageResolveResponse> {
  if (!src.startsWith('https://')) {
    return fail('denied', `Only https URLs are allowed: ${src}`);
  }

  // Cache hit?
  const cached = await this.getCache().get(src);
  if (cached) {
    const data = `data:${cached.mime};base64,${cached.buffer.toString('base64')}`;
    return {
      ok: true,
      attachment: {
        name: path.basename(new URL(src).pathname) || 'image',
        type: cached.mime,
        size: cached.buffer.byteLength,
        data,
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(src, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      return fail('timeout', `Fetch timed out after ${REMOTE_FETCH_TIMEOUT_MS}ms`);
    }
    return fail('fetch_failed', (err as Error).message);
  }
  clearTimeout(timer);

  if (!response.ok) {
    return fail('fetch_failed', `HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    return fail('unsupported', `Content-Type is not image/*: ${contentType}`);
  }

  const declaredLen = Number(response.headers.get('content-length') ?? '0');
  if (declaredLen > MAX_IMAGE_BYTES) {
    return fail('too_large', `Content-Length ${declaredLen} exceeds max ${MAX_IMAGE_BYTES}`);
  }

  const arrayBuf = await response.arrayBuffer();
  if (arrayBuf.byteLength > MAX_IMAGE_BYTES) {
    return fail('too_large', `Downloaded ${arrayBuf.byteLength} exceeds max ${MAX_IMAGE_BYTES}`);
  }

  const buffer = Buffer.from(arrayBuf);
  const mime = contentType.split(';')[0].trim();

  await this.getCache().put(src, buffer, mime);

  const ext = extensionForMime(mime) ?? '.img';
  const baseName = path.basename(new URL(src).pathname) || `image${ext}`;

  return {
    ok: true,
    attachment: {
      name: baseName,
      type: mime,
      size: buffer.byteLength,
      data: `data:${mime};base64,${buffer.toString('base64')}`,
    },
  };
}
```

- [ ] **Step 8: Run resolver tests again (expect pass)**

Run: `npx vitest run src/main/services/image-resolver.spec.ts`
Expected: ALL PASS (local + 6 remote cases).

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.electron.json` and `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/main/services/image-cache.ts src/main/services/image-cache.spec.ts src/main/services/image-resolver.ts src/main/services/image-resolver.spec.ts
git commit -m "feat(main): ImageResolver remote fetch with FS-backed LRU cache"
```

---

## Task 7: ImageResolver — data URI resolution + SVG sanitization

**Files:**
- Modify: `src/main/services/image-resolver.ts` (replace `resolveData` stub, add SVG sanitization)
- Modify: `src/main/services/image-resolver.spec.ts`

- [ ] **Step 1: Add failing tests for data URIs and SVG sanitization**

Append to `src/main/services/image-resolver.spec.ts`:

```typescript
describe('ImageResolver.resolveData', () => {
  const resolver = new ImageResolver();

  it('accepts a valid png data URI', async () => {
    const src = `data:image/png;base64,${pngFixture().toString('base64')}`;
    const result = await resolver.resolve({ kind: 'data', src });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachment.type).toBe('image/png');
  });

  it('rejects a malformed data URI', async () => {
    const result = await resolver.resolve({ kind: 'data', src: 'data:not-a-uri' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_data_uri');
  });

  it('rejects non-image data URIs', async () => {
    const result = await resolver.resolve({
      kind: 'data',
      src: 'data:text/plain;base64,aGVsbG8=',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported');
  });

  it('rejects data URIs over MAX_IMAGE_BYTES', async () => {
    const bigPayload = Buffer.alloc(11 * 1024 * 1024).toString('base64');
    const result = await resolver.resolve({
      kind: 'data',
      src: `data:image/png;base64,${bigPayload}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_large');
  });
});

describe('ImageResolver SVG sanitization', () => {
  it('strips <script> from SVG data URIs', async () => {
    const dangerousSvg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>';
    const src = `data:image/svg+xml;base64,${Buffer.from(dangerousSvg).toString('base64')}`;

    const resolver = new ImageResolver();
    const result = await resolver.resolve({ kind: 'data', src });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const decoded = Buffer.from(
        result.attachment.data.split(',')[1],
        'base64'
      ).toString('utf8');
      expect(decoded).not.toContain('<script');
      expect(decoded).toContain('<rect');
    }
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `npx vitest run src/main/services/image-resolver.spec.ts`
Expected: New data-URI and SVG tests FAIL.

- [ ] **Step 3: Implement `resolveData` + SVG sanitization**

Edit `src/main/services/image-resolver.ts`. Add import at top:

```typescript
import DOMPurify from 'isomorphic-dompurify';
```

Add helper method inside the class:

```typescript
private sanitizeSvg(svgText: string): string {
  return DOMPurify.sanitize(svgText, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick'],
  });
}
```

Replace the `resolveData` stub with:

```typescript
private async resolveData(src: string): Promise<ImageResolveResponse> {
  const match = src.match(/^data:([^;,]+)(?:;([^,]*))?,(.*)$/s);
  if (!match) {
    return fail('invalid_data_uri', 'Data URI could not be parsed');
  }
  const mime = match[1].toLowerCase();
  const params = match[2] ?? '';
  const payload = match[3];

  if (!mime.startsWith('image/')) {
    return fail('unsupported', `Data URI is not image/*: ${mime}`);
  }

  const isBase64 = /(^|;)base64(;|$)/i.test(params);
  let buffer: Buffer;
  try {
    buffer = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch (err) {
    return fail('invalid_data_uri', (err as Error).message);
  }

  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return fail('too_large', `Data URI payload ${buffer.byteLength} exceeds ${MAX_IMAGE_BYTES}`);
  }

  let finalBuffer = buffer;
  if (mime === 'image/svg+xml') {
    const sanitized = this.sanitizeSvg(buffer.toString('utf8'));
    finalBuffer = Buffer.from(sanitized, 'utf8');
  }

  const ext = extensionForMime(mime) ?? '.img';
  return {
    ok: true,
    attachment: {
      name: `image${ext}`,
      type: mime,
      size: finalBuffer.byteLength,
      data: `data:${mime};base64,${finalBuffer.toString('base64')}`,
    },
  };
}
```

Also update `resolveLocal` and `resolveRemote` to sanitize SVGs. In `resolveLocal`, after reading the buffer and before building the data URL:

```typescript
let finalBuffer = buffer;
if (mime === 'image/svg+xml') {
  const sanitized = this.sanitizeSvg(buffer.toString('utf8'));
  finalBuffer = Buffer.from(sanitized, 'utf8');
}
const data = `data:${mime};base64,${finalBuffer.toString('base64')}`;
// use finalBuffer.byteLength as the size below
```

Same pattern in `resolveRemote` after the buffer is downloaded.

- [ ] **Step 4: Run tests (expect pass)**

Run: `npx vitest run src/main/services/image-resolver.spec.ts`
Expected: ALL PASS (local, remote, data, and SVG sanitization).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.electron.json` and `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/image-resolver.ts src/main/services/image-resolver.spec.ts
git commit -m "feat(main): ImageResolver data-URI resolution and SVG sanitization"
```

---

## Task 8: Register `image:resolve` IPC handler

**Files:**
- Modify: `src/main/ipc/handlers/image-handlers.ts` — add new handler invocation.
- Modify: `src/main/ipc/ipc-main-handler.ts` (or wherever `registerImageHandlers` is wired) — verify it is called. If not, wire it.

- [ ] **Step 1: Locate where `registerImageHandlers` is called**

Run: `grep -rn "registerImageHandlers" src/main/`
Expected: at least one result in `src/main/ipc/ipc-main-handler.ts` or `src/main/index.ts`. If zero results, we need to add the registration call in the same place other `register*Handlers()` functions are invoked.

- [ ] **Step 2: Add IMAGE_RESOLVE handler**

Edit `src/main/ipc/handlers/image-handlers.ts`. Add at the top alongside existing imports:

```typescript
import { getImageResolver } from '../../services/image-resolver';
import { ImageResolveRequestSchema } from '@contracts/schemas/image';
```

(The import path for `ImageResolveRequestSchema` should match the monorepo's path alias — check an existing file that imports from `packages/contracts/src/schemas/...` for the correct alias. If no alias is in use, use the relative form `../../../../packages/contracts/src/schemas/image.schemas`. Note that `@contracts/...` subpaths require three-way sync per the packaging note in AGENTS.md: `tsconfig.json`, `tsconfig.electron.json`, and `src/main/register-aliases.ts`.)

Inside `registerImageHandlers()`, add after the existing handlers:

```typescript
ipcMain.handle(
  IPC_CHANNELS.IMAGE_RESOLVE,
  validatedHandler(
    'IMAGE_RESOLVE',
    ImageResolveRequestSchema,
    async (validated): Promise<IpcResponse> => {
      const result = await getImageResolver().resolve(validated);
      return { success: true, data: result };
    }
  )
);
```

The handler wraps the resolver's `ImageResolveResponse` in the standard `{ success, data }` envelope so the renderer's `ElectronIpcService` can unwrap it uniformly.

- [ ] **Step 3: Verify registration**

Re-run: `grep -n "registerImageHandlers" src/main/`
Confirm there is exactly one call site that fires on app startup.

If not wired, add the call in the same file where `register*Handlers` calls are batched (likely `src/main/ipc/ipc-main-handler.ts`). Example:

```typescript
registerImageHandlers();
```

Place alongside the other register* calls in main startup.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/handlers/image-handlers.ts src/main/ipc/ipc-main-handler.ts
git commit -m "feat(ipc): wire IMAGE_RESOLVE handler to ImageResolver"
```

---

## Task 9: Preload bridge method

**Files:**
- Modify: `src/preload/domains/file.preload.ts` (around line 148, within the Image Operations section)

- [ ] **Step 1: Add `imageResolve` method**

Edit `src/preload/domains/file.preload.ts`. Inside the Image Operations block, after `imageContextMenu`, add:

```typescript
/**
 * Resolve an image reference (local path, https URL, or data URI) to a
 * base64 data-URL FileAttachment, executed in the main process.
 */
imageResolve: (payload: {
  kind: 'local' | 'remote' | 'data';
  src: string;
  alt?: string;
}): Promise<IpcResponse> => {
  return ipcRenderer.invoke(ch.IMAGE_RESOLVE, payload);
},
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/preload/domains/file.preload.ts
git commit -m "feat(preload): expose imageResolve bridge"
```

---

## Task 10: Renderer-side IPC wrapper

**Files:**
- Modify: `src/renderer/app/core/services/ipc/file-ipc.service.ts` — add `resolveImage` method.
- Test: `src/renderer/app/core/services/ipc/file-ipc.service.spec.ts` (create if missing; otherwise add to existing).

- [ ] **Step 1: Check if a spec file exists**

Run: `ls src/renderer/app/core/services/ipc/file-ipc.service.spec.ts` — if missing, skip to Step 2 without TDD on this wrapper (it's thin pass-through).

- [ ] **Step 2: Add `resolveImage` to FileIpcService**

Edit `src/renderer/app/core/services/ipc/file-ipc.service.ts`. Add imports at top:

```typescript
import type {
  ImageResolveRequest,
  ImageResolveResponse,
} from '../../../../../../packages/contracts/src/schemas/image.schemas';
```

(Adjust path to match project alias — `@contracts/schemas/image` if such alias exists in `tsconfig.json`. Check how `file-ipc.service.ts` or sibling services import from `packages/contracts/` and mirror that.)

Add method inside the class (after `writeTextFile`, before the next section separator):

```typescript
/**
 * Resolve an image reference to a FileAttachment via the main process.
 * Returns null if IPC is unavailable or the main-process wrapper reports failure.
 */
async resolveImage(request: ImageResolveRequest): Promise<ImageResolveResponse | null> {
  if (!this.api) return null;
  const response = await (this.api as unknown as {
    imageResolve: (payload: ImageResolveRequest) => Promise<{
      success: boolean;
      data?: ImageResolveResponse;
      error?: { message: string };
    }>;
  }).imageResolve(request);
  if (!response.success || !response.data) return null;
  return response.data;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/core/services/ipc/file-ipc.service.ts
git commit -m "feat(renderer): FileIpcService.resolveImage wrapper"
```

---

## Task 11: Store method — `appendAttachmentsToMessage`

**Files:**
- Modify: `src/renderer/app/core/state/instance/instance-output.store.ts` (append method at end of class)
- Test: `src/renderer/app/core/state/instance/instance-output.store.spec.ts` (create or extend)

- [ ] **Step 1: Write the failing test**

Write (or append to) `src/renderer/app/core/state/instance/instance-output.store.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InstanceOutputStore } from './instance-output.store';
import { InstanceStateService } from './instance-state.service';
import type { FileAttachment, FailedImageRef } from '../../../../../shared/types/instance.types';

describe('InstanceOutputStore.appendAttachmentsToMessage', () => {
  let store: InstanceOutputStore;
  let stateService: InstanceStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(InstanceOutputStore);
    stateService = TestBed.inject(InstanceStateService);

    stateService.state.set({
      instances: new Map([
        ['inst-1', {
          id: 'inst-1',
          // minimal stub instance — only fields the method touches matter
          outputBuffer: [
            { id: 'msg-1', timestamp: 1, type: 'assistant', content: 'hi' },
          ],
          // cast as any to avoid enumerating all Instance fields in the test
        } as any],
      ]),
    } as any);
  });

  it('appends attachments and sets metadata.imagesResolved', () => {
    const attachment: FileAttachment = {
      name: 'og.png',
      type: 'image/png',
      size: 100,
      data: 'data:image/png;base64,AAA',
    };

    store.appendAttachmentsToMessage('inst-1', 'msg-1', [attachment], []);

    const state = stateService.state();
    const instance = state.instances.get('inst-1')!;
    const msg = instance.outputBuffer.find(m => m.id === 'msg-1')!;

    expect(msg.attachments).toEqual([attachment]);
    expect(msg.metadata?.['imagesResolved']).toBe(true);
  });

  it('appends failures to failedImages', () => {
    const fail: FailedImageRef = {
      src: 'https://example.com/missing.png',
      kind: 'remote',
      reason: 'fetch_failed',
      message: 'HTTP 404',
    };

    store.appendAttachmentsToMessage('inst-1', 'msg-1', [], [fail]);

    const state = stateService.state();
    const msg = state.instances.get('inst-1')!.outputBuffer.find(m => m.id === 'msg-1')!;
    expect(msg.failedImages).toEqual([fail]);
  });

  it('is a no-op for unknown message ids', () => {
    store.appendAttachmentsToMessage('inst-1', 'nope', [
      { name: 'x.png', type: 'image/png', size: 1, data: 'data:x' }
    ], []);

    const state = stateService.state();
    const msg = state.instances.get('inst-1')!.outputBuffer.find(m => m.id === 'msg-1')!;
    expect(msg.attachments).toBeUndefined();
  });

  it('produces a new outputBuffer array reference (signal-safe)', () => {
    const before = stateService.state().instances.get('inst-1')!.outputBuffer;
    store.appendAttachmentsToMessage('inst-1', 'msg-1', [
      { name: 'x.png', type: 'image/png', size: 1, data: 'data:x' }
    ], []);
    const after = stateService.state().instances.get('inst-1')!.outputBuffer;
    expect(after).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

Run: `npx vitest run src/renderer/app/core/state/instance/instance-output.store.spec.ts`
Expected: FAIL — method does not exist.

- [ ] **Step 3: Implement the method**

Edit `src/renderer/app/core/state/instance/instance-output.store.ts`. Add imports at top:

```typescript
import type { FileAttachment, FailedImageRef } from '../../../../../shared/types/instance.types';
```

Append this method to the class (after `prependOlderMessages`):

```typescript
/**
 * Append resolved image attachments and failed-image refs to an existing
 * assistant message. Produces a fresh outputBuffer array reference so
 * zoneless Angular signals re-render correctly.
 */
appendAttachmentsToMessage(
  instanceId: string,
  messageId: string,
  newAttachments: FileAttachment[],
  newFailures: FailedImageRef[]
): void {
  if (newAttachments.length === 0 && newFailures.length === 0) {
    // Still mark resolved so we don't re-run the extractor.
    this.markImagesResolved(instanceId, messageId);
    return;
  }

  this.stateService.state.update((current) => {
    const newMap = new Map(current.instances);
    const instance = newMap.get(instanceId);
    if (!instance) return current;

    const idx = instance.outputBuffer.findIndex((m) => m.id === messageId);
    if (idx < 0) return current;

    const existing = instance.outputBuffer[idx];
    const updatedMsg: OutputMessage = {
      ...existing,
      attachments: [
        ...((existing.attachments ?? []) as FileAttachment[]),
        ...newAttachments,
      ],
      failedImages: [
        ...(existing.failedImages ?? []),
        ...newFailures,
      ],
      metadata: { ...(existing.metadata ?? {}), imagesResolved: true },
    };

    const newBuffer = [
      ...instance.outputBuffer.slice(0, idx),
      updatedMsg,
      ...instance.outputBuffer.slice(idx + 1),
    ];

    newMap.set(instanceId, { ...instance, outputBuffer: newBuffer });
    return { ...current, instances: newMap };
  });
}

/**
 * Mark a message as images-resolved without adding attachments (e.g., when
 * the message has no image references and we want to skip future extraction).
 */
markImagesResolved(instanceId: string, messageId: string): void {
  this.stateService.state.update((current) => {
    const newMap = new Map(current.instances);
    const instance = newMap.get(instanceId);
    if (!instance) return current;

    const idx = instance.outputBuffer.findIndex((m) => m.id === messageId);
    if (idx < 0) return current;

    const existing = instance.outputBuffer[idx];
    if (existing.metadata?.['imagesResolved']) return current;

    const updatedMsg: OutputMessage = {
      ...existing,
      metadata: { ...(existing.metadata ?? {}), imagesResolved: true },
    };

    const newBuffer = [
      ...instance.outputBuffer.slice(0, idx),
      updatedMsg,
      ...instance.outputBuffer.slice(idx + 1),
    ];

    newMap.set(instanceId, { ...instance, outputBuffer: newBuffer });
    return { ...current, instances: newMap };
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/renderer/app/core/state/instance/instance-output.store.spec.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/core/state/instance/instance-output.store.ts src/renderer/app/core/state/instance/instance-output.store.spec.ts
git commit -m "feat(renderer): InstanceOutputStore.appendAttachmentsToMessage"
```

---

## Task 12: `ImageAttachmentService` — effect-driven orchestrator

**Files:**
- Create: `src/renderer/app/features/instance-detail/image-attachment.service.ts`
- Test: `src/renderer/app/features/instance-detail/image-attachment.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Write `src/renderer/app/features/instance-detail/image-attachment.service.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ImageAttachmentService } from './image-attachment.service';
import { InstanceOutputStore } from '../../core/state/instance/instance-output.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';

describe('ImageAttachmentService', () => {
  let service: ImageAttachmentService;
  let store: { appendAttachmentsToMessage: ReturnType<typeof vi.fn>; markImagesResolved: ReturnType<typeof vi.fn> };
  let ipc: { resolveImage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    store = {
      appendAttachmentsToMessage: vi.fn(),
      markImagesResolved: vi.fn(),
    };
    ipc = { resolveImage: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        ImageAttachmentService,
        { provide: InstanceOutputStore, useValue: store },
        { provide: FileIpcService, useValue: ipc },
      ],
    });
    service = TestBed.inject(ImageAttachmentService);
  });

  it('marks messages with no image refs as resolved and calls no IPC', async () => {
    await service.processMessage('inst-1', {
      id: 'msg-1',
      timestamp: 1,
      type: 'assistant',
      content: 'just text, no images',
    } as any);

    expect(ipc.resolveImage).not.toHaveBeenCalled();
    expect(store.markImagesResolved).toHaveBeenCalledWith('inst-1', 'msg-1');
  });

  it('resolves all refs in parallel and appends successes', async () => {
    ipc.resolveImage.mockResolvedValueOnce({
      ok: true,
      attachment: { name: 'a.png', type: 'image/png', size: 1, data: 'data:a' },
    });
    ipc.resolveImage.mockResolvedValueOnce({
      ok: true,
      attachment: { name: 'b.png', type: 'image/png', size: 2, data: 'data:b' },
    });

    await service.processMessage('inst-1', {
      id: 'msg-1',
      timestamp: 1,
      type: 'assistant',
      content: '![](https://fal.media/a.png) and ![](https://fal.media/b.png)',
    } as any);

    expect(ipc.resolveImage).toHaveBeenCalledTimes(2);
    expect(store.appendAttachmentsToMessage).toHaveBeenCalledWith(
      'inst-1',
      'msg-1',
      [
        { name: 'a.png', type: 'image/png', size: 1, data: 'data:a' },
        { name: 'b.png', type: 'image/png', size: 2, data: 'data:b' },
      ],
      []
    );
  });

  it('records failures separately', async () => {
    ipc.resolveImage.mockResolvedValueOnce({
      ok: true,
      attachment: { name: 'a.png', type: 'image/png', size: 1, data: 'data:a' },
    });
    ipc.resolveImage.mockResolvedValueOnce({
      ok: false,
      reason: 'fetch_failed',
      message: 'HTTP 404',
    });

    await service.processMessage('inst-1', {
      id: 'msg-1',
      timestamp: 1,
      type: 'assistant',
      content: '![](https://fal.media/a.png) ![](https://fal.media/b.png)',
    } as any);

    const [instanceId, messageId, attachments, failures] = store.appendAttachmentsToMessage.mock.calls[0];
    expect(instanceId).toBe('inst-1');
    expect(messageId).toBe('msg-1');
    expect(attachments).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      src: 'https://fal.media/b.png',
      reason: 'fetch_failed',
    });
  });

  it('treats a null IPC response as a failure', async () => {
    ipc.resolveImage.mockResolvedValueOnce(null);

    await service.processMessage('inst-1', {
      id: 'msg-1',
      timestamp: 1,
      type: 'assistant',
      content: '![](https://fal.media/a.png)',
    } as any);

    const [, , attachments, failures] = store.appendAttachmentsToMessage.mock.calls[0];
    expect(attachments).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe('fetch_failed');
  });

  it('skips messages already marked imagesResolved', async () => {
    await service.processMessage('inst-1', {
      id: 'msg-1',
      timestamp: 1,
      type: 'assistant',
      content: '![](https://fal.media/a.png)',
      metadata: { imagesResolved: true },
    } as any);

    expect(ipc.resolveImage).not.toHaveBeenCalled();
    expect(store.appendAttachmentsToMessage).not.toHaveBeenCalled();
    expect(store.markImagesResolved).not.toHaveBeenCalled();
  });

  it('skips streaming messages', async () => {
    await service.processMessage('inst-1', {
      id: 'msg-1',
      timestamp: 1,
      type: 'assistant',
      content: '![](https://fal.media/a.png)',
      metadata: { streaming: true },
    } as any);

    expect(ipc.resolveImage).not.toHaveBeenCalled();
  });

  it('skips non-assistant messages', async () => {
    await service.processMessage('inst-1', {
      id: 'msg-1',
      timestamp: 1,
      type: 'user',
      content: '![](https://fal.media/a.png)',
    } as any);

    expect(ipc.resolveImage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `npx vitest run src/renderer/app/features/instance-detail/image-attachment.service.spec.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the service**

Write `src/renderer/app/features/instance-detail/image-attachment.service.ts`:

```typescript
import { Injectable, inject } from '@angular/core';
import { InstanceOutputStore } from '../../core/state/instance/instance-output.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import type { FileAttachment, FailedImageRef } from '../../../../../shared/types/instance.types';
import { extractImageReferences, type ImageReference } from './image-reference-extractor';

@Injectable({ providedIn: 'root' })
export class ImageAttachmentService {
  private store = inject(InstanceOutputStore);
  private ipc = inject(FileIpcService);

  /**
   * Public entry point. Extracts image refs, calls IPC for each in parallel,
   * and appends results to the message via the store. Idempotent — a message
   * with metadata.imagesResolved=true is skipped.
   */
  async processMessage(instanceId: string, message: OutputMessage): Promise<void> {
    if (message.type !== 'assistant') return;
    if (message.metadata?.['streaming'] === true) return;
    if (message.metadata?.['imagesResolved'] === true) return;

    const refs = extractImageReferences(message.content);
    if (refs.length === 0) {
      this.store.markImagesResolved(instanceId, message.id);
      return;
    }

    const results = await Promise.all(refs.map((ref) => this.resolveOne(ref)));

    const attachments: FileAttachment[] = [];
    const failures: FailedImageRef[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const ref = refs[i];
      if (result && result.ok) {
        attachments.push(result.attachment);
      } else {
        failures.push({
          src: ref.src,
          kind: ref.kind,
          reason: result?.ok === false ? result.reason : 'fetch_failed',
          message: result?.ok === false ? result.message : 'IPC unavailable',
        });
      }
    }

    this.store.appendAttachmentsToMessage(instanceId, message.id, attachments, failures);
  }

  private async resolveOne(ref: ImageReference) {
    return this.ipc.resolveImage({ kind: ref.kind, src: ref.src, alt: ref.alt });
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `npx vitest run src/renderer/app/features/instance-detail/image-attachment.service.spec.ts`
Expected: ALL PASS (7 cases).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/features/instance-detail/image-attachment.service.ts src/renderer/app/features/instance-detail/image-attachment.service.spec.ts
git commit -m "feat(chat): ImageAttachmentService — extract + resolve + append"
```

---

## Task 13: Wire `ImageAttachmentService` to finalized messages

**Files:**
- Modify: `src/renderer/app/core/state/instance/instance-output.store.ts` — invoke `ImageAttachmentService.processMessage` when a streaming message finalizes.

The trigger point must fire once per assistant message, after it finalizes. The cleanest place is inside `flushOutput`, where we already loop over pending messages and know which IDs are streaming vs. finalized.

- [ ] **Step 1: Inject ImageAttachmentService (deferred via Injector)**

Because `ImageAttachmentService` depends on `InstanceOutputStore`, we get a circular DI if we inject directly. Use Angular's `Injector` for lazy lookup.

Edit `src/renderer/app/core/state/instance/instance-output.store.ts`. Add imports:

```typescript
import { Injector } from '@angular/core';
// Use a forward-declared token to avoid the circular import.
```

Replace the current constructor/injection setup to:

```typescript
@Injectable({ providedIn: 'root' })
export class InstanceOutputStore {
  private stateService = inject(InstanceStateService);
  private ngZone = inject(NgZone);
  private injector = inject(Injector);
  private imageAttachmentService: import('../../../features/instance-detail/image-attachment.service').ImageAttachmentService | null = null;

  private async getImageAttachmentService() {
    if (!this.imageAttachmentService) {
      // Lazy import to break circular DI at module-load time.
      const mod = await import('../../../features/instance-detail/image-attachment.service');
      this.imageAttachmentService = this.injector.get(mod.ImageAttachmentService);
    }
    return this.imageAttachmentService;
  }
  // ...
}
```

- [ ] **Step 2: Trigger the service when a message finalizes**

Inside `flushOutput`, after the state update that applies pending messages, add a post-flush step that runs for each finalized assistant message:

```typescript
flushOutput(instanceId: string): void {
  // ...existing code that updates state...

  // After the state.update call returns, find assistant messages in `pending`
  // that are NOT streaming and have an id we haven't processed yet.
  const finalizedAssistants = pending.filter(
    (m) =>
      m.type === 'assistant' &&
      !(m.metadata && 'streaming' in m.metadata && m.metadata['streaming'] === true)
  );

  // Also, any message that transitioned OUT of streaming needs to be reprocessed.
  // A message transitions to finalized when the next pending chunk for the same
  // id arrives WITHOUT streaming=true. We detect this by re-reading state.
  const instance = this.stateService.state().instances.get(instanceId);
  const finalizedFromStream: OutputMessage[] = [];
  if (instance) {
    for (const msg of pending) {
      const isStreamingChunk =
        msg.metadata &&
        'streaming' in msg.metadata &&
        msg.metadata['streaming'] === true;
      if (isStreamingChunk) continue;
      // Look up the final stored version (after the state update applied above).
      const stored = instance.outputBuffer.find((m) => m.id === msg.id);
      if (stored && stored.type === 'assistant' && !stored.metadata?.['imagesResolved']) {
        finalizedFromStream.push(stored);
      }
    }
  }

  const toProcess = new Map<string, OutputMessage>();
  for (const m of [...finalizedAssistants, ...finalizedFromStream]) {
    toProcess.set(m.id, m);
  }

  if (toProcess.size > 0) {
    // Fire-and-forget; the service appends attachments back into state when done.
    void this.getImageAttachmentService().then((svc) => {
      for (const msg of toProcess.values()) {
        svc.processMessage(instanceId, msg).catch((err: unknown) => {
          console.warn('[InstanceOutputStore] image resolution failed', err);
        });
      }
    });
  }
}
```

Place this block at the end of `flushOutput`, after the existing `stateService.state.update(...)` call.

- [ ] **Step 3: Add an integration test that exercises the flush → service wire-up**

Append to `src/renderer/app/core/state/instance/instance-output.store.spec.ts`:

```typescript
describe('InstanceOutputStore flush triggers image attachment processing', () => {
  let store: InstanceOutputStore;
  let stateService: InstanceStateService;
  let ipcMock: { resolveImage: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    ipcMock = {
      resolveImage: vi.fn().mockResolvedValue({
        ok: true,
        attachment: { name: 'og.png', type: 'image/png', size: 1, data: 'data:x' },
      }),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: FileIpcService, useValue: ipcMock },
      ],
    });
    store = TestBed.inject(InstanceOutputStore);
    stateService = TestBed.inject(InstanceStateService);

    stateService.state.set({
      instances: new Map([
        ['inst-1', {
          id: 'inst-1',
          outputBuffer: [],
        } as any],
      ]),
    } as any);
  });

  it('resolves images for a finalized assistant message after flush', async () => {
    store.queueOutput('inst-1', {
      id: 'msg-1',
      timestamp: 1,
      type: 'assistant',
      content: '![](https://fal.media/x.png)',
    });

    // Force the throttle timer to flush immediately.
    store.flushInstanceOutput('inst-1');

    // Let the async image-resolution microtasks settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(ipcMock.resolveImage).toHaveBeenCalledTimes(1);
    const msg = stateService.state().instances.get('inst-1')!.outputBuffer[0];
    expect(msg.attachments).toHaveLength(1);
    expect(msg.metadata?.['imagesResolved']).toBe(true);
  });

  it('does not resolve while the message is still streaming', async () => {
    store.queueOutput('inst-1', {
      id: 'msg-1',
      timestamp: 1,
      type: 'assistant',
      content: '![](https://fal.media/x.png)',
      metadata: { streaming: true, accumulatedContent: '![](https://fal.media/' },
    });

    store.flushInstanceOutput('inst-1');
    await new Promise((r) => setTimeout(r, 50));

    expect(ipcMock.resolveImage).not.toHaveBeenCalled();
  });
});
```

Add the extra imports at the top of the spec file:

```typescript
import { FileIpcService } from '../../services/ipc/file-ipc.service';
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 5: Run existing tests to ensure nothing regressed**

Run: `npx vitest run src/renderer/app/core/state/instance/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/core/state/instance/instance-output.store.ts src/renderer/app/core/state/instance/instance-output.store.spec.ts
git commit -m "feat(chat): trigger ImageAttachmentService on finalized assistant messages"
```

---

## Task 14: Failed-image fallback component

**Files:**
- Create: `src/renderer/app/shared/components/failed-image-card/failed-image-card.component.ts`

- [ ] **Step 1: Write the component**

Write `src/renderer/app/shared/components/failed-image-card/failed-image-card.component.ts`:

```typescript
import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import type { FailedImageRef } from '../../../../../shared/types/instance.types';

@Component({
  selector: 'app-failed-image-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="failed-image-container">
      @for (failure of failures(); track failure.src) {
        <div class="failed-image-card">
          <div class="failed-icon" aria-hidden="true">⚠</div>
          <div class="failed-body">
            <div class="failed-title">Couldn't load image</div>
            <div class="failed-src" [title]="failure.src">{{ truncateMid(failure.src) }}</div>
            <div class="failed-reason">{{ humanReason(failure) }}</div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .failed-image-container {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      margin-top: 0.5rem;
    }
    .failed-image-card {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.5rem 0.6rem;
      border: 1px dashed var(--color-border, #555);
      border-radius: 4px;
      background: var(--color-surface-subtle, rgba(255,255,255,0.03));
      font-size: 0.85rem;
    }
    .failed-icon { font-size: 1rem; line-height: 1; padding-top: 0.1rem; }
    .failed-body { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
    .failed-title { font-weight: 500; }
    .failed-src {
      font-family: var(--font-mono, monospace);
      font-size: 0.8rem;
      opacity: 0.75;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 420px;
    }
    .failed-reason { font-size: 0.8rem; opacity: 0.8; }
  `],
})
export class FailedImageCardComponent {
  failures = input.required<FailedImageRef[]>();

  humanReason(f: FailedImageRef): string {
    switch (f.reason) {
      case 'too_large': return 'File is too large (max 10 MB).';
      case 'not_found': return 'File not found.';
      case 'denied': return 'Access denied (path or URL not allowed).';
      case 'fetch_failed': return `Fetch failed — ${f.message}`;
      case 'unsupported': return `Unsupported format — ${f.message}`;
      case 'timeout': return 'Download timed out.';
      case 'invalid_data_uri': return 'Malformed data URI.';
      default: return f.message;
    }
  }

  truncateMid(s: string): string {
    if (s.length <= 64) return s;
    return `${s.slice(0, 40)}…${s.slice(-20)}`;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/shared/components/failed-image-card/failed-image-card.component.ts
git commit -m "feat(ui): FailedImageCardComponent for unresolvable image refs"
```

---

## Task 15: Render failed-image card in output stream

**Files:**
- Modify: `src/renderer/app/features/instance-detail/output-stream.component.ts` (around lines 117-119 and 216-218)

- [ ] **Step 1: Import the new component**

Edit the imports list at the top of `output-stream.component.ts`. Add:

```typescript
import { FailedImageCardComponent } from '../../shared/components/failed-image-card/failed-image-card.component';
```

Add `FailedImageCardComponent` to the `imports` array of the `@Component` decorator (alongside `MessageAttachmentsComponent`).

- [ ] **Step 2: Add the card after the attachments block for the response message**

Locate the block (around line 117) that reads:

```typescript
@if (item.response.attachments && item.response.attachments.length > 0) {
  <app-message-attachments [attachments]="item.response.attachments" />
}
```

Immediately after this block, add:

```typescript
@if (item.response.failedImages && item.response.failedImages.length > 0) {
  <app-failed-image-card [failures]="item.response.failedImages" />
}
```

- [ ] **Step 3: Same for the message block (around line 216)**

Locate:

```typescript
@if (item.message.attachments && item.message.attachments.length > 0) {
  <app-message-attachments [attachments]="item.message.attachments" />
}
```

Add immediately after:

```typescript
@if (item.message.failedImages && item.message.failedImages.length > 0) {
  <app-failed-image-card [failures]="item.message.failedImages" />
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Lint the modified file**

Run: `npx eslint src/renderer/app/features/instance-detail/output-stream.component.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/features/instance-detail/output-stream.component.ts
git commit -m "feat(ui): render failed-image card in output stream"
```

---

## Task 16: End-to-end manual verification in the dev app

Automated tests can't cover full integration in a zoneless Angular + Electron environment, so this task is a scripted manual check.

- [ ] **Step 1: Build and launch the app**

Run: `npm run dev`
Expected: Electron window opens, loads the renderer.

- [ ] **Step 2: Drive a test case for each source kind**

Prepare a test conversation manually. With an open instance, paste into the assistant-echo tool (or simulate assistant output however you do it during dev) these three messages one at a time and verify the outcome:

**Test A — local file (control):**

Message content:
```
Here is the OG image: ![og](/Users/suas/work/orchestrat0r/ai-orchestrator/test-fixtures/test.png)
```

Before sending, create the file: `mkdir -p test-fixtures && cp any-png test-fixtures/test.png`.

Expected:
- A thumbnail appears below the message within ~1 s.
- Clicking the thumbnail opens the existing lightbox.
- DevTools: no CSP violations in the console.

**Test B — remote URL:**

Message content:
```
generated: https://fal.media/files/penguin/ZkBnkPLr54fAgNoRdIvOM.png
```

(Use any real, publicly-fetchable image URL.)

Expected:
- Thumbnail appears within a few seconds.
- Second instance of the same URL in a subsequent message loads instantly (cache hit). Verify by watching the main-process log — no second fetch.

**Test C — data URI:**

Generate a tiny PNG as a data URI and paste it in a message via markdown syntax.

Expected: thumbnail appears immediately (no IPC fetch delay).

**Test D — failure mode:**

Message content:
```
missing: https://example.invalid/nope.png
```

Expected: failed-image card appears with "Fetch failed — …" message.

**Test E — denied local path:**

Message content:
```
forbidden: /etc/hosts
```

Expected: no thumbnail (fails extension gate) or denied card (if the extension check is bypassed — shouldn't be).

- [ ] **Step 3: Run the full suite**

Run: `npm run test`
Expected: PASS.

Run: `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: If anything fails, debug with the existing logger**

Main-process logs live in `~/Library/Logs/ai-orchestrator/` on macOS (or wherever the logger writes). Filter for `[ImageResolver]` and `[ImageCache]` to trace flow.

- [ ] **Step 5: Commit any stabilizing fixes**

```bash
git commit -am "fix(chat): stabilize inline image resolution after manual verification"
```

(Only if fixes were needed; otherwise skip.)

---

## Post-implementation audit

After all 16 tasks pass:

- [ ] **Audit A — CSP untouched:** `grep -n "img-src" src/renderer/index.html` — confirm unchanged.
- [ ] **Audit B — No CSP violations:** launch app, open 5+ chats with images, DevTools Console filter `CSP` — expect zero entries.
- [ ] **Audit C — Cache directory exists:** `ls "$HOME/Library/Application Support/AI Orchestrator/media-cache/"` — should contain hashed `.bin` / `.json` pairs after remote image loads.
- [ ] **Audit D — SVG sanitization:** craft a malicious SVG locally (see SVG test in Task 7) and verify the rendered DOM via DevTools has no `<script>` nodes.
- [ ] **Audit E — Memory footprint:** open ~20 messages with images, check Electron memory in Activity Monitor — should grow by roughly the sum of on-screen image sizes (remote images stay in cache, not message state, only the base64 data URL is in state which is the single copy).
- [ ] **Audit F — Streaming safety:** trigger a long streaming response with `![x](https://...)` mid-stream — verify the extractor doesn't fire until the message finalizes (no duplicate thumbnails, no partial-URL failures).

---

## Open decisions deferred to follow-ups

Noted here so they aren't lost when this plan ships:

1. **Stripping parsed refs from rendered text.** Currently we leave Claude's raw text untouched. If broken-img placeholders from the markdown renderer become visible, add a one-line strip in `MarkdownService` (not here).
2. **Custom `orchestrator-media://` protocol.** If the `attachments: base64` state hits memory trouble at scale, the resolver's return shape can be swapped from inline data URLs to media-protocol URLs without changing any consumer. `MessageAttachmentsComponent` reads `attachment.data` — change that value, everything downstream just works.
3. **Relative paths (`./foo.png`).** Out of scope for this plan. Would require a CWD anchor per instance, which we have on the `Instance` type (`workingDirectory`). Future work.
4. **Additional image hosts.** No allowlist on `resolveRemote` — any https URL is fetchable by the main process. If this ever needs restricting, add a setting `allowedImageHosts: string[]` gated in `ImageResolver.resolveRemote`.
