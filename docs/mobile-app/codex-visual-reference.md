# Codex Mobile App — Visual Reference

Reference screenshots James supplied for the AI Orchestrator mobile control app.
The actual PNGs live in `./reference-images/`. This file is a written spec of each
so the look/feel is usable during implementation even without opening the images.

Aesthetic target in one line: **true-black iOS dark UI, generous whitespace, large
soft typography, monochrome line icons, one warm accent (green = online), pill-shaped
floating controls.** It should feel like a first-party iOS app, not a web page.

---

## Screenshot 1 — `reference-images/codex-01-home-projects.png` (THE primary model)

The Codex app's home screen for a single connected host.

**Status bar:** real iOS status bar (00:41, silent icon, signal/wifi/battery).

**Top bar:**
- Left: circular dark-grey button (~44px) with a hamburger / "two lines" glyph → opens the host/nav drawer.
- Right: circular dark-grey button with a "•••" overflow glyph → opens the Organize/Manage menu (screenshot 3).

**Title block:**
- `Codex` — very large (~34–40px), bold, white, tight to the left margin.
- Below it: a small **green filled dot** + `MacBook-Pro.local` in medium-grey (~15px).
  This is the **connected host** and its **online state**. (In our app this is an
  AI Orchestrator instance; the `.local` name is a Bonjour/mDNS hostname.)

**Projects section:**
- Section label `Projects` (white, ~17px semibold) with vertical breathing room above it.
- A vertical list of project rows. Each row:
  - Left: a monochrome **folder** outline icon (~22px, light grey).
  - Project name in white (~17px): `suas`, `ai-orchestrator`, `Noah`, `binsout`,
    `dingley-assessment`, `ebrd`, `communitytech`.
  - A small **`>` chevron** immediately after names that can drill in (not all rows have it).
  - Far right: a faint **compose/edit** (pencil-in-square) icon → start a new chat in that project.
  - Rows are tall (~52px), no dividers, no card — just space.

**Chats section:**
- Label `Chats` with a small **`⌄` disclosure caret** next to it (collapsible) and a
  compose icon on the far right.
- Below: one greyed preview line of the most recent loose chat: `can you create a secret gist:…`.

**Bottom (floating, above home indicator):**
- Left: a wide **pill search field**, dark grey, magnifier icon + placeholder `Search Chats`.
- Right: a **white pill button** with a compose glyph + `Chat` label (the primary CTA;
  inverted/white to stand out).

**Takeaways for our app:**
- Host name + green dot = our **instance picker / connection status** header.
- Projects = our **instances grouped by `workingDirectory`** (see plan §domain).
- Per-row compose = "new session in this project".
- Floating search + primary "new" CTA at the bottom, thumb-reachable.

---

## Screenshot 2 — `reference-images/chatgpt-02-sidebar-codex-entry.png` (context only)

The ChatGPT app's left navigation drawer (shows where "Codex" lives inside ChatGPT).
Useful only as **drawer/navigation** inspiration; we are not cloning ChatGPT.

- Header `ChatGPT` (large white) with a pill on the right containing a search magnifier
  and a blue circular "new" button.
- Stacked nav items with leading line icons: `Images`, **`Codex`** (highlighted/selected
  with a rounded grey active background), `More` (•••).
- `GPTs` section → `Angular 20` (with a small circular avatar).
- `Projects` section → `New project` (folder-plus icon), `CommunityTech`, `Noah`,
  `Easy tech`, `EBRD` (folder icons).
- `Recents` section → flat list of recent chat titles in white.
- Same floating white **`Chat`** CTA pill, bottom-right.

**Takeaways:** the **slide-in drawer** pattern (selected-item highlight pill, grouped
sections with leading icons) is a good model for our **host/instance switcher** drawer —
the place to switch between multiple AI Orchestrator instances ("potentially more than one").

---

## Screenshot 3 — `reference-images/codex-03-organize-menu.png` (the overflow menu)

Same Codex home as screenshot 1 with the top-right `•••` menu open as a floating
rounded popover (dark, slightly translucent, soft shadow, rounded ~20px corners).

**`Organize` group** (small grey caption header):
- ✓ `By project` (folder icon) — checked/active.
- `Chronological list` (clock-with-arrow icon).
- `Chats first` (chat-bubbles icon).

Thin divider.

**`Manage` group:**
- `Cloud threads` (cloud icon).
- `Archived chats` (archive-box icon).
- `Connections` (globe icon).

Each item: leading line icon + white label, comfortable row height, left-aligned.

**Takeaways:**
- The **organize modes** ("By project" / "Chronological" / "Chats first") map directly
  onto our list grouping (group by project/workingDirectory vs flat-by-recency). Ship
  "By project" first; the others are cheap follow-ups.
- `Connections` is the analog of our **manage-hosts/pairing** entry point.

---

## Design tokens to extract (starting point)

| Token | Value (approx) | Use |
|---|---|---|
| `--bg` | `#000000` true black | app background |
| `--surface` | `#1c1c1e` / `#2c2c2e` | buttons, search pill, popover |
| `--text` | `#ffffff` | primary text |
| `--text-secondary` | `#8e8e93` | host name, previews, captions |
| `--accent-online` | `#34c759` (iOS green) | online dot / healthy status |
| `--accent-attention` | `#ff9f0a` (amber) | "awaiting approval / input" (our addition) |
| `--accent-error` | `#ff453a` (red) | error/failed status (our addition) |
| `--cta` | `#ffffff` bg / black text | primary "new" pill |
| radius | 14–20px rows/pills, ~22px FABs | rounded, soft |
| type | SF Pro; title ~36 bold, row ~17, caption ~13–15 | large & airy |

Status colors for sessions should reuse the desktop mapping in
`src/renderer/app/features/instance-list/status-indicator.component.ts`
(`STATUS_COLORS` / `STATUS_LABELS`) so phone and desktop agree.
