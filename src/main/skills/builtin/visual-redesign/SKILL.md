---
name: visual-redesign
description: Non-destructive visual upgrade of an existing React/web UI. Separates sacred logic from replaceable styling, applies all changes through a single load-last gold.css override so one import removal reverts everything, and gates completion on a functionality checklist. Use for "redesign this ui", "visual overhaul", "make this look designed". Do not use for backend work, logic changes, new features, or bug fixes.
triggers: ["/visual-redesign", "redesign this ui", "redesign the ui", "visual overhaul", "make this look designed", "make this ui look designed"]
version: 1.0.0
category: design
effort: medium
---

# Visual Redesign (non-destructive)

Methodology adapted from VibeCurb by Yu-369 (MIT, github.com/Yu-369/VibeCurb).

You are a surgeon, not a demolition crew. JavaScript logic is sacred; styling is replaceable. The #1 way a redesign "breaks the app" is restructuring JSX for aesthetics and accidentally removing a conditional wrapper, moving a key prop, changing a ref, or reordering DOM-position-dependent children. Never restructure working JSX for looks.

## Sacred (never modify)

State declarations and updates (useState/useReducer), effect and memo bodies (useEffect/useCallback/useMemo), API calls (fetch/axios/SWR/React Query), event-handler logic (what happens onClick, not how the button looks), conditional rendering (ternaries, && chains), router/navigation, form validation, context providers/consumers, custom hooks, data transformations, error handling, prop interfaces, third-party integration logic.

## Slop (upgrade aggressively)

className strings, inline styles, CSS/SCSS files, Tailwind/Bootstrap utility classes, color values, font families/sizes, spacing, border-radius, shadows, transitions/animations, z-index, flex/grid layout configuration, wrapper divs that exist purely for layout.

Gray zone (className bound to state, style driven by state, .map()/key structures, refs, aria-*/data-*/id): keep the logic, change only the values. Golden rule: if unsure whether something is logic or style, leave it alone and add styles alongside it — a less elegant CSS override that works beats an elegant refactor that breaks the app.

## Pipeline

1. **Audit** — read every file in scope. Table each file: type, sacred elements, slop elements, risk (low/medium/high). Note aesthetic crimes (framework-default blue like #0d6efd, generic font stack, no hover states, pure black-on-white).
2. **Extract** — build the "slop sheet": current tokens, typography, spacing, colors, components, atmosphere, motion.
3. **Prescribe** — for every slop item, a replacement in ONE new stylesheet: `gold.css`. Tokens first (background off-white like #FAFAF9, text near-black #1A1A1A, negative heading letter-spacing, radius scale, custom cubic-bezier easings — never keyword easings), then components, atmosphere (subtle warmth, grain overlay opacity 0.025–0.06, gradient opacity < 0.3), then motion (reveals 600–900ms, entry sequence < 800ms total, transform/opacity only, prefers-reduced-motion fallback).
4. **Surgery** — import `gold.css` LAST, after all existing CSS. Loading after existing styles overrides defaults without deleting anything; removing that one import reverts the entire redesign. Do NOT delete old CSS/Bootstrap imports until the override is confirmed stable — the old CSS is the safety net. Work one layer at a time (tokens → typography → color → spacing → components → atmosphere → motion) and test after each layer. Permitted JSX additions only: inert `data-reveal` attributes, added classNames, CSS-variable style props — handlers untouched.
   - Tailwind projects: override `tailwind.config.js` theme (colors/fonts/radii/shadows) instead of editing component files.
   - CSS-in-JS: one global-style override module. MUI/Chakra/Ant: override the theme provider; never fight component structure.
   - Vanilla HTML: `gold.css` as the last stylesheet in head; `!important` only if the existing CSS forces it.
5. **Post-op** — run the checklist below. Scoped requests ("just the hero") get the same pipeline applied to that section only; upgrading more than asked wastes time and adds risk.

## Post-op checklist (gate — run before claiming done)

**Functionality (must all pass FIRST; if any fails, revert the last surgery layer and diagnose before continuing):** routes load; forms submit; API data renders; state toggles work; handlers fire; auth flow works; no console errors; no type errors; conditional rendering intact.

**Visual:** no framework-default blues; no pure black-on-white; display-grade heading font; negative heading letter-spacing; heading line-height < 1.15; hover lift + active press feedback; consistent radius per component type; warm consistent palette (≤3 hues).

**Motion:** no CSS keyword easings; entry < 800ms; transform/opacity only; prefers-reduced-motion respected.

**Responsive:** 1440/768/375px clean; no horizontal overflow; 44px minimum touch targets.

**Rollback:** removing the `gold.css` import cleanly reverts everything; no old CSS deleted; no JSX structural changes.
