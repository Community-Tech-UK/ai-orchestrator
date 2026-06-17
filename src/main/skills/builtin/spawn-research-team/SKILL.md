---
name: spawn-research-team
trigger: /research-team
description: Spawn multiple children to research a topic from different angles
parameters:
  - name: topic
    required: true
  - name: perspectives
    default: ["technical", "user-experience", "business"]
---

# Research Team Skill

When triggered, spawn child instances to research the given topic from different perspectives.

## Usage
/research-team <topic>

## Behavior
1. Parse the topic from the user's message
2. Spawn N child instances (one per perspective). Use non-Claude providers (`gemini`, `codex`, `copilot`, or `cursor`) unless the user explicitly requested Claude.
3. Each child researches from their assigned perspective
4. Collect results and synthesize into comprehensive report

## Parameters
- **topic**: The subject to research
- **perspectives**: List of angles to explore (default: technical, UX, business)

## Example
```
/research-team authentication strategies for microservices
```

This would spawn three children:
1. Technical perspective: security protocols, encryption, token management
2. User experience perspective: login flows, session handling, error states
3. Business perspective: compliance, cost, vendor lock-in

## Output
A comprehensive report synthesizing all perspectives with:
- Executive summary
- Findings per perspective
- Trade-offs and recommendations
- Implementation considerations
