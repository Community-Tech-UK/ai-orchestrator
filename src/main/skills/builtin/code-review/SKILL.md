---
name: code-review
trigger: /code-review
description: Spawn multiple children to review code from different quality dimensions
parameters:
  - name: files
    required: true
  - name: aspects
    default: ["security", "performance", "maintainability", "testing"]
---

# Code Review Skill

When triggered, spawn child instances to review code from different quality perspectives.

## Usage
/code-review <file-pattern>

## Behavior
1. Identify files matching the pattern
2. Spawn N child instances (one per review aspect). Use non-Claude providers (`gemini`, `codex`, `copilot`, or `cursor`) unless the user explicitly requested Claude.
3. Each child performs focused review on their assigned aspect
4. Collect findings and synthesize into actionable report

## Parameters
- **files**: File path or glob pattern to review
- **aspects**: Quality dimensions to evaluate (default: security, performance, maintainability, testing)

## Example
```
/code-review src/main/orchestration/**/*.ts
```

This would spawn four children:
1. Security reviewer: vulnerabilities, injection risks, data exposure
2. Performance reviewer: bottlenecks, memory leaks, algorithmic efficiency
3. Maintainability reviewer: code clarity, documentation, technical debt
4. Testing reviewer: coverage gaps, edge cases, test quality

## Output
A structured code review report with:
- Critical issues requiring immediate attention
- Medium/low priority improvements
- Best practices recommendations
- Specific file/line references for each finding
- Suggested refactorings
