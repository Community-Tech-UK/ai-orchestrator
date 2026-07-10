# Angular Conventions

These are the always-on conventions for this Angular 21, zoneless renderer. Project-specific state, styling, HTTP, and build choices remain in `AGENTS.md` and the codebase.

## Components

- Use standalone components only. Do not create new `NgModule` files.
- Set `changeDetection: ChangeDetectionStrategy.OnPush` on every component.
- Use `inject()` for dependency injection, not constructor parameters.
- Use the `input()` and `output()` signal APIs, not `@Input()` or `@Output()` decorators.
- Use `@defer` for non-critical heavy UI such as below-the-fold panels, charts, and modals when deferral materially helps startup.

## Reactivity

- Use `signal`, `computed`, and `effect` for component state.
- Convert RxJS streams at component boundaries with `toSignal()`.
- Prefer signal-based services and stores over `BehaviorSubject` for shared state.
- Keep writable signals private. Expose readonly signals and explicit mutation methods.

## File Naming

- Components: `feature-name.component.ts`
- Services: `feature-name.service.ts`
- Stores: `feature-name.store.ts`
- Models/types: `feature-name.model.ts` or `feature-name.types.ts`
- Routes: `feature-name.routes.ts`
- Tests: `<file>.spec.ts` beside the file under test

## Layout and Routing

Use `core/` for app-wide singletons and root state, `shared/` for reusable presentational components, and `features/` for feature-owned code. Let feature folders grow only when needed.

Lazy-load features with `loadComponent` or `loadChildren`. Keep route definitions in `<feature>.routes.ts` beside the feature.

## Zoneless Runtime

The app uses `provideZonelessChangeDetection()`. Do not import `zone.js` or rely on zone-dependent behavior such as `NgZone.run()`.

## Code Style

- Prefer `const` when a binding is not reassigned.
- Put generic arguments on constructors, for example `new Map<string, Entry>()`.
- Omit annotations inferred from literals.
- Remove unused imports.
- Do not install packages without user approval.
- Do not hand-edit generated files; change their source or generator instead.
