---
name: verify-implementation
trigger: /verify
description: Spawn multiple children to verify implementation meets requirements from different angles
parameters:
  - name: requirements
    required: true
  - name: scope
    required: false
  - name: aspects
    default: ["functional", "integration", "edge-cases", "performance"]
---

# Verify Implementation Skill

When triggered, spawn child instances to verify an implementation against requirements.

## Usage
/verify <requirements-or-spec>

## Behavior
1. Parse requirements/specification
2. Identify implementation scope (files, features)
3. Spawn N child instances (one per verification aspect). Use non-Claude providers (`gemini`, `codex`, `copilot`, or `cursor`) unless the user explicitly requested Claude.
4. Each child verifies from their assigned perspective
5. Aggregate results into pass/fail report with findings

## Parameters
- **requirements**: Requirements document, spec, or feature description
- **scope**: Optional file pattern to limit verification scope
- **aspects**: Verification dimensions (default: functional, integration, edge-cases, performance)

## Example
```
/verify The user authentication should support OAuth2, rate limiting, and remember-me functionality
```

This would spawn four children:
1. Functional verifier: core OAuth2 flow, rate limiting logic, remember-me cookies
2. Integration verifier: database interactions, external OAuth providers, session storage
3. Edge-case verifier: expired tokens, concurrent logins, malformed requests
4. Performance verifier: login latency, token refresh overhead, rate limit efficiency

## Output
A verification report with:
- Pass/fail status for each requirement
- Detailed findings per verification aspect
- Missing functionality identified
- Implementation gaps or bugs discovered
- Test coverage assessment
- Recommendations for fixes or improvements
