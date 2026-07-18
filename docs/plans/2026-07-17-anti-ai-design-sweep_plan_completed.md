# Anti-AI Design Sweep — 2026-07-17

Apply the banned-pattern list from James's `design-anti-patterns.md` attachment to the AIO renderer. The app already has a deliberate palette (graphite/moss/bronze "Operator Workspace"), so this is a targeted purge of the remaining tells, not a redesign.

## Survey findings (verified by grep, 2026-07-17)

| Violation | Count | Notes |
|---|---|---|
| Plus Jakarta Sans (banned stock-AI font) | theme + echarts | `styles/_theme.scss:10,272-273`, `echarts-themed.component.ts:13` |
| Purple/violet/pink hexes | 37 in 19 files | incl. `--status-initializing: #a855f7`, `--memory-short-term: #8b5cf6`, `--memory-long-term: #ec4899` |
| All-caps labels + letter-spacing | ~270 | spread across ~40 feature dirs |
| Colored left-border stripes | ~31 | "the em-dash of UI design" |
| backdrop-filter (glassmorphism) | 20 | |
| Blurred colored glows | ~25+ | `--shadow-glow` token + component-level `0 0 Npx rgba(color)` |
| Colored radial "blob" washes behind content | `styles/_base.scss:25-27,48` | workspace background glows |
| Emoji as icons (incl. ✨) | 30+ sites | memory, training, debate, instance-detail, skills, review, chats |
| Banned copy words | 0 | clean |

## Decisions

1. **Font**: Plus Jakarta Sans → **IBM Plex Sans** (deliberate technical voice, pairs with JetBrains Mono, not on the banned list). Keep JetBrains Mono.
2. **Palette keeps its point of view** (graphite/moss/bronze). Retune stock-Tailwind status colors to warmer, desaturated variants that sit in the palette; keep them unambiguous.
3. **Purple purge**: `--status-initializing` → neutral sage-grey; `--memory-short-term` → teal; `--memory-long-term` → bronze; component-level purples remapped to palette hues. High-contrast theme purples → vivid non-purple equivalents.
4. **Focus rings stay** (hard-edged `0 0 0 Npx` rings are accessibility, not glow). Blurred colored shadows (`0 0 12px rgba(...)` etc.) are removed or made neutral.
5. **Glass**: remove `backdrop-filter` blurs; surfaces become solid elevated backgrounds. The low-alpha `--glass-*` hover fills stay (they are hover tints, not frosted cards).
6. **Uppercase labels**: drop `text-transform: uppercase` + wide `letter-spacing`; labels become sentence-case, keep size/weight hierarchy (bump weight where needed).
7. **Left-border status stripes** → subtle full border + background tint in the same status color.
8. **Emoji icons**: prefer removal where adjacent text already carries meaning ("⚡ YOLO" → "YOLO"); otherwise inline stroke SVG per the `empty-state` idiom. No sparkles anywhere.
9. **Dark default stays** (operator tool; muted text verified ≥ 4.5:1 on its surfaces).
10. **Decorative gradients/blob washes** in `_base.scss` removed; functional gradients (skeleton shimmer, scroll fades) stay.

## Workstreams

- **WS1 (global, in-loop)**: `_theme.scss`, `_base.scss`, `_component-utilities.scss`, `echarts-themed` — fonts, tokens, glow/wash removal. Status: DONE.
- **WS2–WS6 (per-slice sweeps, 5 parallel subagents)**: full rule set applied across all 68 feature dirs + shared/core/styles partials (~150 files changed). Status: DONE; coordinator follow-up pass removed the last emoji icon sites (user-action-request icons, agent-mode icons, file-type icon map, hardened/loop-send/skill-browser emoji) and fixed a pre-existing broken focus-ring var (`--primary-color-rgb` → `--primary-rgb` in debate-visualization).
- **WS7 (gates + audit)**: residual greps clean (all categories zero or justified below); `npx tsc --noEmit` clean, spec tsc clean, `npm run lint` clean, `check:ts-max-loc` passed (3 pre-existing main-process tolerance notes only), full `npm run test:quiet` → 1501 files / 14,843 tests passed. Real-UI smoke: dev Electron launched via playwright `_electron` (`_scratch/design-smoke.cjs`), dashboard + seeded instance screenshots verified (flat surfaces, sentence-case labels, no purple/emoji/glass). Status: DONE.

## As-built justified residuals

- `channel-connections.component.ts:224` — `text-transform: uppercase` on a live pairing-code `<input>` (functional formatting of typed characters, not a label).
- `auxiliary-models-settings-tab.component.scss:216` — `border-left: 2px solid var(--accent-color, var(--border-color))`; `--accent-color` is undefined in the theme so it always renders the neutral border fallback.
- Zero-blur rings (`0 0 0 Npx`) kept app-wide — focus/selection affordances, not glows.
- Monochrome typographic glyphs (✓ ✕ ✗ ⚠ ↻ ✎ → ↑ etc.) kept — established app icon idiom, not pictorial emoji. Pictorial-emoji sweep (U+1F300–1FAFF) over renderer html/ts is zero outside specs.
- Single-hue functional gradients kept: skeleton shimmer, scroll-edge fades, progress-bar fills, neutral sheens.
- Em dashes already present in existing UI copy were left (rule applied to new copy); no banned marketing copy found anywhere.

## Out of scope

Landing-page-only rules (hero stacks, testimonial cards, logo marquees, pricing skeletons) — the app has no marketing surfaces. Light-theme palette redesign beyond the token remaps above.
