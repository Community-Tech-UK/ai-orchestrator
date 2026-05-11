# Observational Memory & Cognitive Architecture Research

## 1. Industry Implementation Patterns

### Google Gemini: Vector-Based Extraction
*   **Pattern:** **Extraction-Embedding-Retrieval**
*   **Mechanism:** Uses an LLM to "read" conversation history and extract key facts/entities into a structured format. These are then embedded (vectorized) and stored.
*   **Retrieval:** Semantic search against the vector store is used to inject relevant context into the prompt.
*   **Key Lesson:** Don't just stuff context; *extract* semantic meaning first.

### OpenAI ChatGPT: Hierarchical Memory
*   **Pattern:** **Short/Medium/Long-Term Tiering**
*   **Mechanism:**
    *   *Short-term:* Raw session buffer.
    *   *Medium-term:* Session summaries.
    *   *Long-term (Core):* A "Bio" or "Profile" that stores user preferences and persistent facts.
*   **User Control:** Explicit UI to view/delete specific memory "facts" is crucial for trust.

### Microsoft Copilot: Graph-Based Context
*   **Pattern:** **Contextual Grounding via Knowledge Graph**
*   **Mechanism:** Uses the "Microsoft Graph" (relationships between emails, docs, meetings) to "ground" the prompt before it hits the LLM.
*   **Enterprise Integration:** Stores memory in compliance-friendly locations (e.g., hidden Exchange folders) rather than opaque vector DBs.

### Anthropic Claude: Project-Based Artifacts
*   **Pattern:** **File-Based Workspace Memory**
*   **Mechanism:** Memory is scoped to "Projects". Uses a `CLAUDE.md` style file to store project-specific instructions and context.
*   **Artifacts:** Distinct separate window/storage for generated code/docs, treating them as persistent objects rather than just chat text.
*   **Lesson:** Scoping memory to a "Project" reduces context pollution compared to a global "User" memory.

## 2. Cognitive Architectures & Theory

### OAR Loop (Observation-Action-Reflection)
*   **Concept:** The fundamental run-loop of an agent.
*   **Implementation:**
    1.  **Observe:** Read environment state (files, git status, linter errors).
    2.  **Reflect (Thought):** Analyze the observations against the goal. *Crucial step often missed.*
    3.  **Act:** Execute a tool or command.
*   **Relevance:** Most simple agents skip "Reflect". Adding a dedicated "Self-Correction" step improves reliability significantly.

### SOAR & ACT-R (Cognitive Models)
*   **SOAR:** Uses **Reinforcement Learning (RL)** on "Operator Selection". It learns *which* rule to apply in a given state based on past success.
*   **ACT-R:** Distinct **Declarative Memory** (facts/chunks) vs. **Procedural Memory** (rules/skills).
    *   *Application:* Your orchestrator could have separate DBs for "Facts" (Project X uses Angular) and "Skills" (How to fix a Vitest error).

### Cognitive Load Theory
*   **Concept:** Working memory is finite. Overloading it causes "hallucination" (errors).
*   **Application:**
    *   **Chunking:** Summarize old conversation turns.
    *   **Externalizing:** Move state out of the context window and into files (Artifacts).
    *   **Germane Load:** Only inject context *relevant* to the immediate problem (RAG).

## 3. Practical Implementation for TypeScript/Electron Orchestrator

Based on the research, here is a recommended architecture for your system:

### A. The "Memory Manager" Service (TypeScript)
Implement a service that mimics the **ACT-R** split:

```typescript
interface MemorySystem {
  // Declarative Memory (RAG / Vector Store)
  // Implementation: SQLite with Vector extension or local JSON vector store
  facts: {
    add(content: string, tags: string[]): Promise<void>;
    query(context: string): Promise<string[]>;
  };

  // Procedural Memory (Prompts / Heuristics)
  // Implementation: Folder of .md files or structured JSON prompts
  skills: {
    getPromptForTask(taskType: string): string;
    refineSkill(taskType: string, feedback: string): Promise<void>; // SOAR-like learning
  };

  // Episodic Memory (Session History)
  // Implementation: JSON file per session
  episodes: {
    logInteraction(input: string, output: string, metadata: any): void;
    summarizeSession(sessionId: string): Promise<string>; // For "Medium-term" memory
  };
}
```

### B. The "Project Context" (Claude Pattern)
Adopt the **Claude** pattern of filesystem-based memory.
*   Create a `.orchestrator/` folder in the user's project root.
*   Store `memory.md` (editable by user and agent) and `context.json` (machine state).
*   This keeps memory "grounded" in the specific project.

### C. The OAR Loop Implementation
Structure your Agent's `run` function as an explicit OAR loop:

```typescript
async function runAgentLoop(goal: string) {
  let state = await observeEnvironment(); // Observation

  while (!isComplete(state)) {
    const reflection = await cognitiveEngine.reflect(state, goal); // Reflection
    // "I should check the test output before writing code..."

    const plan = await cognitiveEngine.plan(reflection);
    const action = plan.nextStep;

    const result = await tools.execute(action); // Action

    // Observational Memory Hook:
    await memory.episodes.logInteraction(action, result, reflection);

    state = await observeEnvironment(); // New Observation
  }
}
```

### D. "Observational Memory" Feature
To implement the specific "Observational" aspect:
1.  **Passive Watcher:** The Electron app should have a file watcher.
2.  **Diff Analysis:** When a file changes, run a lightweight "Reflector" agent.
    *   *Did this change fix the error?* -> **Store as Success Pattern.**
    *   *Did this change cause a build break?* -> **Store as Avoidance Pattern.**
3.  **Active Injection:** When the user starts a similar task later, query the "Success Patterns" and inject: *"Last time you fixed this error by updating `tsconfig.json`."*
