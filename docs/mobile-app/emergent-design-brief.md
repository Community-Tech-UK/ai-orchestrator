# Harness mobile app: design brief for Emergent

## What we're asking for

We want three design directions for an iPhone app that lets one person watch and steer AI coding agents running on their computers. One should polish today's look; the other two should try something new. Build them as clickable prototypes with made-up data. There is no backend to connect to; this round is about ideas, not production code.

**Harness** is a desktop app that runs many AI coding assistants at once (Claude, Codex, Gemini, Copilot and others). Each assistant works in a "session": a chat thread tied to a project folder, where the agent reads code, runs commands and edits files. Some sessions run for hours.

The **mobile app** is the remote control for that desktop app. It connects to one or more computers running Harness (called "hosts") over a private network. From the phone you can read what each agent is doing, send it messages, approve or refuse the actions it asks permission for, stop it, and start new sessions. A version of this app already works; we want fresh ideas for how it should look and feel.

## Who uses it, and when

The user is one developer running 5 to 30 agent sessions at a time across two or three computers. They are away from the desk: on the sofa, in a queue, in a meeting. They glance at the phone for 10 to 60 seconds, so the app must answer "does anything need me?" before anything else.

The moments that matter most, in order:

1. **A notification says an agent needs permission.** They tap it, see what the agent wants to do and why, and tap Allow or Deny. This must take under 10 seconds and be impossible to get wrong.
2. **Checking in.** Which agents are working, which finished, which are stuck or asking a question.
3. **Steering one agent.** Open a session, skim the latest progress, type or dictate a short reply, maybe attach a screenshot.
4. **Starting new work.** Pick a computer, a project folder and an AI model, then write the first message.
5. **Background jobs.** See long-running work (repeating loops, a queue of planned tasks, scheduled jobs) and pause, resume or stop it.
6. **Approving a document.** An agent asks the user to approve a plan item by item: approve, reject or comment on each.

## Screens to design

The first five screens are the core and every direction must include them. The rest can be lighter sketches, but show where they live in the navigation. The current app reaches the background-work screens from a menu; we are open to a better structure.

| Screen | What it must show and do | Priority |
| --- | --- | --- |
| Needs you | Everything waiting on the user, across all computers: permission requests, questions from agents, sessions that just finished. Tapping one goes straight to the action. | Core |
| Projects and sessions | The connected computer (name plus online dot), its project folders, and the sessions in each with a live status. Search, filter by status, and a way to switch computer. | Core |
| Conversation | One session's chat: the user's messages, the agent's replies (with code blocks and file changes), tool activity such as "ran tests" or "edited 3 files", and a live "working" indicator. A message box at the bottom with dictation, photo attachment, a Stop button, and messages queued while the agent is busy. | Core |
| Permission request | Appears on top of any screen. Shows which computer, project and session, what the agent wants to do (a command, a file edit with a before and after view), and Allow or Deny. Allow can be for this once, or for this session. Some requests are questions with options to pick from. | Core |
| New session | Choose computer, project folder (recent ones first), AI provider and model, then the first message. | Core |
| Computers | Paired computers with online or offline state; add one by scanning a QR code shown on the desktop. | Sketch |
| Loops | Agents repeating a task until it is done: progress, current round, Pause, Resume, Stop. | Sketch |
| Plan queue | A queue of planned tasks agents work through one by one: each run's state and progress, with Pause, Resume and Cancel. | Sketch |
| Document review | A plan broken into numbered items; approve, reject or comment on each, then Approve all, Request changes or Reject. | Sketch |
| Automations | Scheduled jobs (for example "Daily review, 9am"): next run, last result, Run now. | Sketch |
| Usage | How much of each AI account's allowance is left, as a percentage per account, with reset times. | Sketch |
| History | Past, closed sessions you can search and read. | Sketch |
| Lock screen | Face ID gate when the app opens. | Sketch |

### Session statuses

Every session shows one of these, in these exact words. Each needs a clear, colour-blind-safe visual treatment, not colour alone.

| Status | Meaning | Treatment hint |
| --- | --- | --- |
| Needs your OK | Agent is waiting for permission | Loudest; the user must act |
| Needs your answer | Agent asked a question | Loudest; the user must act |
| Working | Agent is busy | Gentle motion |
| Thinking | Agent has been reasoning for a while | Gentle motion, distinct from Working |
| Ready | Idle, waiting for the next message | Calm |
| Asleep | Paused to save memory; a message wakes it | Dim |
| Restarting | Coming back after a restart | Gentle motion |
| Stopping | Being stopped | Brief, transitional |
| Problem | Hit an error | Clear but not alarming |
| Stopped | Closed or cancelled | Quiet |

A session can also be **Loop running**, shown beside its status.

### Sample data for the prototype

Use made-up data like this so screens feel real:

- **Computers:** "Studio Mac" (online), "Office PC" (online), "Test Mac" (offline).
- **Projects:** `shop-checkout`, `mobile-app`, `marketing-site`, `data-pipeline`, `docs`.
- **Sessions:** "Fix flaky payment test" (Claude, Working, 14 min), "Add dark mode" (Codex, Needs your OK: wants to run `npm install`), "Tidy README" (Gemini, Ready), "Migrate database" (Claude, Problem), "Nightly refactor" (Codex, Loop running, round 4 of 10), "Old spike" (Copilot, Asleep).
- **Permission example:** "Codex wants to edit `src/theme.ts`" with a short before and after view of 6 changed lines.
- **Usage example:** Claude account 62% left, resets in 3 h; Codex account 18% left, resets tomorrow.

## Look and feel

It should feel like a well-made first-party iPhone app, calm and quick, not a web page squeezed onto a phone. Today's app is true-black dark mode, large soft type, plenty of space, thin line icons, one green accent for "online", and pill-shaped floating buttons near the bottom. We want both: one direction that refines this style, and two that are genuinely different takes.

The first direction below is required. For the other two, use the ideas below or propose your own, and make them clearly different from each other:

- **Calm control room.** Required. A polished version of today's style: dark, spacious, minimal, status shown by small precise marks. Fix what feels rough, keep the character.
- **Attention first.** The home screen is a feed of what needs you, ranked by urgency, with everything else one swipe away.
- **Live at a glance.** Rich status cards per agent with live progress, ideas for Lock Screen widgets and Live Activities (the iPhone's live status strip on the Lock Screen and Dynamic Island).

What we care about:

- **Thumb reach.** Main actions in the bottom half of the screen.
- **Status you can read in one glance**, without opening each session.
- **Long agent output stays readable**: code blocks, file changes and tool activity should be scannable, collapsed by default where long.
- **Allow and Deny must never be mistaken for each other.** Make the risky action deliberate.
- **Light and dark modes** both work; the app follows the phone's setting.

Avoid:

- Generic "AI app" styling: purple-to-blue gradients, sparkles, glowing orbs, robot mascots.
- Dashboards packed with charts and numbers nobody reads on a phone.
- Hamburger menus hiding the most important screens.
- Jargon in the interface. Use plain words like the status list above.

## Constraints

- **iPhone first**, designed at 393 × 852 points (iPhone 15 or 16 size). Show one iPad layout if a direction has a strong idea for it; the real app uses a list beside the detail view on wide screens.
- **iOS conventions**: respect the notch and home indicator areas, standard back swipe, bottom sheets for quick choices, system font (SF Pro) unless a direction has a good reason not to.
- **Accessibility**: text contrast at least 4.5 to 1, tap targets at least 44 × 44 points, works with larger text sizes, and no meaning carried by colour alone.
- **Every screen needs its awkward states**: loading, empty ("No reviews waiting"), computer offline, connection lost and reconnecting, and an action that failed.
- **Updates are live.** Statuses and transcripts change while the user watches; design how new content arrives without making the screen jump.
- **Notifications and Lock Screen**: show one permission-request notification with Allow and Deny actions, and one Live Activity idea.
- **Not in scope**: login or accounts (pairing is by QR code), billing, settings beyond appearance and Face ID lock, and any real connection to a server.

## What to send back

1. **Three design directions (one polish of today's style, two new)**, each as a clickable prototype using the sample data. Any front-end stack is fine as long as it runs in a phone-sized browser window.
2. **Per direction:** the five core screens, the permission notification, and one Live Activity or widget idea. Sketch screens are a bonus.
3. **A one-page style sheet per direction**: colours (light and dark), type sizes, spacing, corner shapes, icon style and the status treatments.
4. **A short note per direction** (under 150 words): the idea behind it and what it is better and worse at.
5. One clickable path in each prototype: tap a "Needs your OK" notification, review the file change, tap Allow, land in the conversation and see the agent carry on.

We will judge each direction on:

- How fast you can tell whether anything needs you (under 3 seconds on the home screen).
- How hard it is to approve the wrong thing by accident.
- Whether long agent output stays readable on a small screen.
- Whether it feels like a native iPhone app rather than a website.
- Whether it is distinctive without being gimmicky.
