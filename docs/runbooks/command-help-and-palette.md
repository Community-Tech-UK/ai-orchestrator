# Command Help And Palette Runbook

Use the command palette when an operator needs to discover, inspect, or execute slash commands without remembering exact names.

## Open And Search

- Open the palette with the configured command-palette shortcut from the app keybindings.
- Search by command name, alias, category, or description. Aliases resolve exactly before fuzzy suggestions.
- Disabled commands stay visible when the controller has a disabled reason; read the reason before changing provider, model, working directory, or feature flags.

## Categories

Commands are grouped as review, navigation, workflow, session, orchestration, diagnostics, memory, settings, skill, and custom. Built-in commands and markdown commands share the same registry snapshot, so category drift usually means the markdown frontmatter is missing or invalid.

## `/help`

Run `/help` or open the help browser from the palette. The browser shows categories, examples, usage text, aliases, and disabled-state reasons. Use it to confirm what the registry loaded before editing command markdown.

## Alias Collisions

Alias and name collisions appear in the Doctor `Commands & Skills` section and in command registry diagnostics. Common codes:

- `alias-collision`: two commands define the same alias.
- `alias-shadowed-by-name`: an alias is also a command name.
- `name-collision`: two markdown files define the same command name; highest-priority source wins.
- `invalid-frontmatter-type`: a markdown command has a frontmatter field with the wrong type.

Fix the markdown command frontmatter, refresh Doctor, then reopen the palette to confirm the collision is gone.

## Wave 7 Evidence

- Screenshot: `screenshots/wave-7/command-palette-dark.png`.
- Screenshot: `screenshots/wave-7/command-help-browser-dark.png`.
- Assertions: `screenshots/wave-7/smoke-evidence.json` records the palette open with 4 rows and the help browser open with command metadata present.
