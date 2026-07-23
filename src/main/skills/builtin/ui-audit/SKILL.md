---
name: ui-audit
trigger: /ui-audit
description: Audit a web UI with browser automation, chrome-devtools, viewport sweeps, screenshots, and axe accessibility evidence
parameters:
  - name: url
    required: true
  - name: scope
    required: false
  - name: viewports
    default: ["390x844", "768x1024", "1440x900"]
---

# UI Audit Skill

Use when the user asks for a visual, UX, accessibility, or browser evidence audit.

## Workflow
1. Open the target URL in the managed browser profile.
2. Inspect the page with browser tools and chrome-devtools tools when available.
3. Capture screenshots at the requested viewport matrix.
4. Run the axe runner when `AIO_AXE_RUNNER` and `AIO_BROWSER_URL` are set:
   `"$AIO_AXE_RUNNER" --browser-url "$AIO_BROWSER_URL" --page-url <url> --viewport <WxH> --tags wcag2a,wcag2aa`
5. Report findings by severity with reproduction steps, viewport, screenshot path, and axe violation ids.

## Design-drift signals (adapted from VibeCurb by Yu-369, MIT)

While auditing, also flag patterns that make a UI read as AI-templated:
- Body fonts (Inter/Roboto/Open Sans/Poppins/Arial/Helvetica) used as display/heading fonts; heading letter-spacing not negative (-0.03 to -0.05em expected); hero heading line-height >= 1.1.
- Copy clichés "Elevate/Seamless/Unleash/Next-Gen/Revolutionize"; em dashes in copy; meta-labels like "SECTION 01".
- Purple/blue AI-glow gradients; floating translucent blobs; pure #000/#FFF backgrounds (expect #0a0a0a / warm off-white); more than 3 hues per page.
- Motion: entry sequences over 800ms; CSS keyword easings (ease/ease-in/ease-out/linear); animating layout properties instead of transform/opacity; missing prefers-reduced-motion.
- Interaction: hover effects beyond a subtle lift + shadow; touch targets under 44px.

## Rules
- Use browser tools for real page state instead of guessing from markup alone.
- Check desktop and mobile layouts unless the user narrows scope.
- For login or destructive actions, use the app's approval/manual-step tooling.
- Keep output actionable: issue, evidence, impact, fix recommendation.
