---
name: summarize-children
trigger: /summarize-children
description: Analyze and synthesize results from multiple child instances
parameters:
  - name: children
    required: true
  - name: format
    default: "structured"
---

# Summarize Children Skill

When triggered, analyze results from child instances and synthesize into coherent summary.

## Usage
/summarize-children [format]

## Behavior
1. Retrieve structured results from all child instances; prefer child summaries/artifacts over raw transcript output
2. Identify common themes and conflicts
3. Extract key findings and decisions
4. Synthesize into requested format
5. Highlight critical items requiring attention

If a separate synthesis child is needed, spawn it with a non-Claude provider (`gemini`, `codex`, `copilot`, or `cursor`) unless the user explicitly requested Claude. Do not paste large raw child transcripts into your own context.

## Parameters
- **children**: List of child instance IDs or "all" for all children
- **format**: Output format (structured, executive, technical, markdown)

## Example
```
/summarize-children structured
```

This would:
1. Collect all child results
2. Categorize findings by type (errors, recommendations, decisions)
3. Identify consensus and disagreements
4. Produce structured summary

## Formats

### Structured
- Grouped by finding type
- Severity-sorted
- File references included
- Action items highlighted

### Executive
- High-level overview
- Critical items only
- Business impact focus
- Recommendations prioritized

### Technical
- Detailed technical findings
- Code snippets included
- Architecture implications
- Implementation guidance

### Markdown
- Portable markdown document
- Suitable for documentation
- Section-organized
- Links to source files

## Output
A comprehensive summary containing:
- Overview of child tasks completed
- Aggregated findings by severity
- Consensus recommendations
- Conflicting viewpoints (if any)
- Next steps and action items
- Metrics (time spent, LOC analyzed, issues found)
