# Plans and specifications

Active plans, linked specifications and pending live tests stay untracked in `docs/plans/`.
Follow AGENTS.md's **Plan and Spec Filename States** and **Live-Test Deferral** rules.
After implementation and verification, rename documents with `_completed` before committing.
Never add requirements to a completed document; create a new dated plan for follow-up work.

Run `npm run docs:retire` to review clean, tracked, finished documents older than 30 days.
Only after James approves the actual list, use `--apply --groups <numbers>` to archive them.
The tool moves documents to `docs/_archive/`, records their paths in `INDEX.md`, and never commits.
Run `npm run check:docs-retire` after closing work and report when another batch is due.
