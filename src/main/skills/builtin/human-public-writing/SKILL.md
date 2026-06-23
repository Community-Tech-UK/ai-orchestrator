---
name: human-public-writing
description: Use when writing or editing public-facing prose such as external emails, blog posts, website copy, social posts, press copy, or when the user says use my tone, match my tone, use my voice, sound like me, avoid AI tells, em dash, or emdash.
triggers: ["use my tone", "match my tone", "use my voice", "sound like me", "public-facing writing", "public facing", "external email", "write this email", "draft email", "blog post", "website copy", "social post", "press release", "avoid AI", "AI tells", "em dash", "emdash"]
version: 1.0.0
category: writing
effort: low
---

# Human Public Writing

Use this for public-facing prose and any tone-matching request.

## Hard Rules

- Output zero literal U+2014 em dash characters in drafts, subject lines, headings, commentary, and quoted source text unless the user explicitly says to keep that punctuation.
- When source text contains U+2014, replace it with a comma, colon, parentheses, or a sentence break before presenting the draft.
- The no-em-dash rule outranks "use my tone", "match my tone", "use my voice", and "preserve voice".
- Before responding, scan the final answer for U+2014. If found, rewrite before sending.

## AI-Tell Cleanup

Avoid writing patterns that make public copy read as machine-produced:

- Stock contrasts such as "not only X but Y", "whether you're X or Y", and "from X to Y".
- Inflated adjectives such as seamless, robust, powerful, innovative, comprehensive, game-changing, transformative, and effortless unless the user supplied them.
- Corporate filler such as leverage, elevate, unlock, streamline, supercharge, cutting-edge, and in today's fast-paced world.
- Over-balanced sentence rhythm, repeated three-item lists, tidy thesis-summary endings, and generic warmth.
- Meta-commentary about improving clarity, sounding natural, avoiding AI tells, or matching tone unless the user asks for an audit.

## Tone Matching

Preserve the user's directness, contractions, sentence length, vocabulary, and level of warmth. Keep useful rough edges. Do not over-polish into symmetrical marketing prose.

## Output

Return the requested public-facing copy directly. Include notes only when the user asks for rationale, options, or an audit.
