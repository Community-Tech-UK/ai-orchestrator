# Renderer Architecture

The renderer is organized by ownership boundary:

- `app/core/`: process-wide services, IPC clients, and state stores.
- `app/features/`: route-level and workflow-specific UI. Keep feature-only helpers inside the feature folder.
- `app/shared/`: reusable components, pipes, and presentational primitives with no feature-specific state.

Component structure:

- Standalone Angular components only.
- Use `ChangeDetectionStrategy.OnPush`.
- Use signals, `computed()`, and `inject()` for component state and dependencies.
- Keep templates and styles in separate files when they are more than a small inline snippet.
- Split a component when it owns multiple panels, dialogs, or independently testable interactions.

Size guardrails:

- Aim to keep component `.ts` files under 750 lines.
- Aim to keep templates and styles under 800 lines each.
- If a file needs to exceed those limits, document the reason in the component and prefer extracting feature-local child components or services first.

Global styles:

- `styles.scss` is only the ordered composition root.
- Add design tokens and theme variables in `styles/_theme.scss`.
- Add reset/base element rules in `styles/_base.scss`.
- Add markdown/code rendering rules in `styles/_markdown.scss` and `styles/_code-content.scss`.
- Add shared utility classes in `styles/_component-utilities.scss`.
- Keep route-specific overrides in component styles unless the override must cross component boundaries.
