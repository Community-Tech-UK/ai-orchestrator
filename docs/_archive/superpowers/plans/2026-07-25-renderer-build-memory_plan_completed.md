# Renderer Build Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the Angular development compiler worker from exhausting its V8 heap by limiting the Angular TypeScript program to renderer entrypoints and their imported dependencies.

**Architecture:** Keep the root `tsconfig.json` as the repository-wide TypeScript gate. Add a standard Angular application config rooted at `src/renderer/main.ts`, and point the Angular build target at it so `ng build` and `ng serve` do not treat main-process, preload, script, and unrelated package files as Angular root files.

**Tech Stack:** Angular 21 application builder, TypeScript 5.9, Vitest 3.

## Global Constraints

- Preserve the root `tsconfig.json` behavior used by `npx tsc --noEmit`.
- Preserve renderer imports from `src/shared`, `src/preload`, and workspace packages through normal TypeScript dependency traversal.
- Do not raise `--max-old-space-size`; reduce the compiler program at its source.
- Keep existing unrelated working-tree changes untouched.
- Do not commit or push.

---

### Task 1: Isolate the Angular renderer compilation

**Files:**
- Create: `tsconfig.renderer.json`
- Modify: `angular.json`
- Test: `scripts/__tests__/renderer-build-config.spec.ts`

**Interfaces:**
- Consumes: `src/renderer/main.ts` as the renderer application entrypoint and the compiler options/path aliases from `tsconfig.json`.
- Produces: an Angular build target whose TypeScript root program excludes `src/main`, `scripts`, and unrelated package roots while retaining transitively imported renderer dependencies.

- [x] **Step 1: Write the failing regression test**

Create a Vitest integration test that loads the real Angular workspace configuration, resolves its configured renderer tsconfig, calls the TypeScript API's `parseJsonConfigFileContent`, and asserts:

```typescript
expect(buildOptions.tsConfig).toBe('tsconfig.renderer.json');
expect(rootFiles).toContain(resolve(workspaceRoot, 'src/renderer/main.ts'));
expect(rootFiles.some((file) => file.startsWith(resolve(workspaceRoot, 'src/main') + sep))).toBe(false);
expect(rootFiles.some((file) => file.startsWith(resolve(workspaceRoot, 'scripts') + sep))).toBe(false);
```

The production change that makes this test fail is pointing the Angular target back to the repository-wide tsconfig or broadening the renderer config's roots to include non-renderer subsystems.

- [x] **Step 2: Run the test to verify RED**

Run:

```bash
rtk npm run test:quiet -- scripts/__tests__/renderer-build-config.spec.ts
```

Expected: FAIL because `angular.json` currently points at `tsconfig.json`.

- [x] **Step 3: Add the renderer-only TypeScript config**

Create:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist/out-tsc/renderer",
    "types": []
  },
  "files": [
    "src/renderer/main.ts"
  ],
  "include": [
    "src/renderer/**/*.d.ts"
  ]
}
```

Update `projects.ai-orchestrator.architect.build.options.tsConfig` in `angular.json` from `tsconfig.json` to `tsconfig.renderer.json`.

- [x] **Step 4: Run the regression test to verify GREEN**

Run:

```bash
rtk npm run test:quiet -- scripts/__tests__/renderer-build-config.spec.ts
```

Expected: PASS.

- [x] **Step 5: Verify compiler scope and real development builds**

Run:

```bash
rtk npx tsc --noEmit --listFilesOnly -p tsconfig.renderer.json
rtk npm run build:renderer -- --configuration development
```

Confirm the TypeScript root program no longer contains `src/main` or `scripts`, and the renderer build succeeds.

- [x] **Step 6: Verify incremental `ng serve` behavior**

Start a fresh renderer development server on a spare port, trigger an incremental rebuild by updating an already-read renderer file's mtime, and confirm both the initial and incremental compilations succeed without the worker-memory overlay.

- [x] **Step 7: Run canonical project gates**

Run:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet
```

Expected: all commands exit zero.

- [x] **Step 8: Close the plan after verification**

Record the measured before/after compiler file counts, peak RSS, build duration, targeted test result, UI/runtime result, and canonical gate results in this document. Rename it to `2026-07-25-renderer-build-memory_plan_completed.md` only after every agent-runnable check has passed.

## As-Built Evidence

- Root cause: the Angular build target used the repository-wide `tsconfig.json`, whose implicit roots loaded 4,087 TypeScript files, including 1,571 `src/main` files and 47 `scripts` files.
- Compiler scope after the fix: `tsconfig.renderer.json` loads 1,225 files through `src/renderer/main.ts` and its dependency graph, with zero `src/main` or `scripts` roots.
- Measured development build before the fix: 4,649,730,048 bytes peak RSS and 28.71 seconds.
- Measured development build after the fix: 2,140,930,048 bytes peak RSS and 10.57 seconds.
- Regression test RED: failed because the build target selected `tsconfig.json`.
- Regression test GREEN: `scripts/__tests__/renderer-build-config.spec.ts` passed, 1 file and 1 test.
- Runtime: the renderer dev server restarted successfully on port 4567; its initial build completed in 8.696 seconds. Five incremental rebuilds completed without a worker termination, later rebuilds took 0.193–0.569 seconds, and four successive RSS readings stayed between 2,088,672 KB and 2,120,944 KB before the idle working set fell further.
- Browser verification: the served renderer loaded the normal Harness setup page at `http://localhost:4567/setup`; the accessibility snapshot contained no Angular build-error overlay.
- Canonical gates: production typecheck passed; spec typecheck passed; Angular lint passed; TypeScript max-LOC ratchet passed.
- Full suite: isolated Vitest run passed 4,894 files with 15,571 passed tests and zero failures. The quiet-runner preflight checks also passed.
- Live-test deferral: none.
