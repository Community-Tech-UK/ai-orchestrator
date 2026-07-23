---
name: human-public-writing
description: Use when writing, editing, polishing, or reviewing public-facing prose such as external emails, blog posts, website copy, social posts, newsletters, proposals, bios, press notes, or customer-facing docs; especially when the user says use my tone, match my tone, sound like me, use my voice, avoid AI-sounding writing, ChatGPT style, AI tells, em dashes, formulaic phrasing, corporate filler, or generic polished copy.
triggers: ["use my tone", "match my tone", "use my voice", "sound like me", "public-facing writing", "public facing copy", "public facing email", "external email", "write this email", "draft email", "blog post", "website copy", "social post", "press release", "avoid AI", "AI tells", "em dash", "emdash"]
version: 2.0.0
category: writing
effort: low
---


# Human Public Writing

## Overview

Produce public-facing writing that sounds specific, lived-in, and written for the actual reader. Treat "AI-sounding" as a pattern cluster, not authorship proof: too much symmetry, generic uplift, stock transitions, over-neat structure, and distracting punctuation.

Do not claim text is "AI-free" or human-authored. The goal is practical quality: remove common AI-style tells before copy is published or sent.

## Workflow

1. Identify channel, reader, speaker, goal, and stakes. Ask only when missing context would force filler.
2. For tone matching, extract a working structural fingerprint before drafting: opening move, idea order, qualifications or corrections, paragraph units, sentence-length variation, reader relationship, and ending move.
3. Draft from substance outward: concrete nouns and verbs first, structure second, polish last.
4. Use the user's voice when source material exists. Prefer samples from the same channel and purpose. Preserve useful quirks, but clean input-speed artifacts.
5. Run the audit below before presenting public copy.
6. Revise silently until it passes. Do not include the audit unless asked.

## Structural Voice Matching

Match the shape before the polish. Reproduce how the writer develops a point, not merely their vocabulary and punctuation.

Use a compact fingerprint:

`opening move -> development pattern -> qualification or correction -> ending move`

Keep meaningful irregularity. Do not automatically reorganize the draft into a hook, thesis, balanced list, and recap. Do not imitate typos, misspellings, duplicated punctuation, or accidental fragments. If the current request contains user-authored copy, treat it as stronger evidence than a general profile.

## James's Working Voice Profile

When the primary user is James, use this profile unless his current sample or explicit instruction points elsewhere:

- Start with the actual point, problem, observation, or ask. Skip scene-setting that delays it.
- Develop the thought in motion. Add concrete context, then qualifications, corrections, asides, or constraints in the order they naturally arise.
- Use short paragraph units and varied cadence. Mix concise statements with the occasional longer explanatory sentence. Fragments are acceptable when they sound intentional.
- Be candid about uncertainty with plain phrases such as "I think", "maybe", "I reckon", or a direct question. Do not inflate uncertainty into confidence or soften a conclusion James has stated firmly.
- Address the reader directly. Questions should test the logic, expose the practical issue, or make the ask, not manufacture engagement.
- Prefer plain British English, contractions, concrete examples, and understated wording. Self-deprecating humour can fit when James has already set that tone.
- End on the ask, question, decision, callback, or observation. Do not attach a tidy moral, upbeat summary, or generic invitation to continue.
- Clean spelling and typing mistakes. They reflect speed, not the voice to reproduce.
- Do not manufacture profanity, capitals, humour, or roughness. Preserve them only when the source and audience support them.

## Channel Calibration

Keep the underlying shape while adjusting the surface for the occasion:

- Emails: slightly cleaner and warmer, with the ask near the top and an explicit next step when needed.
- Social posts: allow sharper self-deprecation, a strong concrete opening, and a natural stop. Avoid engagement bait.
- Website and customer copy: make the offer obvious to a non-technical reader. Prefer ordinary words over industry terminology.
- Private messages: allow more compression, correction, fragments, and informality.

## AI-Tell Audit

| Check | Required result |
| --- | --- |
| Punctuation | Use zero em dash characters by default. Prefer commas, colons, parentheses, or separate sentences. Keep semicolons rare. |
| Stock frames | Remove "not just X, but Y", "not only X, but also Y", "it is not about X, it is about Y", "whether X or Y", "from X to Y", "the result?", and "that is where X comes in." |
| Generic openings | Do not start with "in today's fast-paced world", "in an ever-evolving landscape", "in the modern era", or any broad claim that could fit anyone. |
| Vocabulary | Prefer exact words over AI-polish words: delve, tapestry, intricate, crucial, robust, seamless, leverage, utilize, unlock, elevate, transformative, game-changing, cutting-edge, comprehensive, unparalleled, underscore, realm. |
| Structure | Preserve the writer's idea order. Avoid automatic headings, bold-label bullets, numbered frameworks, and tidy recap conclusions unless needed. |
| Cadence | Vary sentence length. Avoid paragraphs with the same shape or every sentence balancing two clauses. |
| Specificity | Replace abstractions with names, dates, constraints, examples, stakes, tradeoffs, or a next step. |
| Tone | Remove vague uplift, exaggerated confidence, and moralizing. Prefer direct, slightly human language over polished neutrality. |

## Public Copy Defaults

Emails: match the relationship, skip "I hope this email finds you well" unless it is the user's style, put the ask near the top, and close with the next step.

Blog, newsletter, and social posts: lead with a concrete tension, observation, claim, or detail. Use bullets only for scanning. End when the idea lands.

Website, product, and proposal copy: name the audience and outcome. Prefer proof, constraints, and differentiators over adjectives.

## Red Flags

| Rationalization | Reality |
| --- | --- |
| "The user asked for polished, so formal is safer." | Public writing should sound intentional, not sanded flat. |
| "One em dash will not matter." | James specifically wants common AI tells removed. Use another punctuation mark. |
| "A list makes everything clearer." | Lists can make prose feel generated. Use them only when they help the reader. |
| "I will clean up the AI tells at the end." | The final audit is mandatory before presenting the copy. |

## Acceptance Criteria

Before final public-facing output:
- No em dash characters remain.
- No stock contrast frame remains unless explicitly requested.
- No generic opening or boilerplate conclusion remains.
- Every paragraph moves the ask, argument, story, or reader action forward.
- At least one concrete detail appears when the user provided facts.
- Formatting matches the channel instead of defaulting to model-friendly markdown.
