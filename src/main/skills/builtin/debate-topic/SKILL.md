---
name: debate-topic
trigger: /debate
description: Spawn children to debate a technical decision from opposing viewpoints
parameters:
  - name: topic
    required: true
  - name: positions
    default: ["for", "against", "moderate"]
  - name: rounds
    default: 2
---

# Debate Topic Skill

When triggered, spawn child instances to debate a technical decision from different viewpoints.

## Usage
/debate <decision-or-topic>

## Behavior
1. Parse the decision/topic to debate
2. Spawn N child instances with opposing positions. Use non-Claude providers (`gemini`, `codex`, `copilot`, or `cursor`) unless the user explicitly requested Claude.
3. Conduct multi-round debate with rebuttals
4. Synthesize findings into balanced recommendation

## Parameters
- **topic**: The technical decision or architectural choice to debate
- **positions**: Viewpoints to argue from (default: for, against, moderate)
- **rounds**: Number of debate rounds (default: 2)

## Example
```
/debate Should we migrate from REST to GraphQL?
```

This would spawn three children:
1. "For" advocate: argues benefits of GraphQL
2. "Against" advocate: argues risks and costs of migration
3. "Moderate" facilitator: identifies middle ground and trade-offs

## Debate Flow
- **Round 1**: Each child presents opening arguments
- **Round 2**: Children respond to opposing arguments
- **Round 3+**: Optional rebuttals when the user requests more rounds

## Output
A balanced analysis including:
- Key arguments from each position
- Critical trade-offs identified
- Context-specific recommendations
- Decision criteria to consider
- Risk mitigation strategies
