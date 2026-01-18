# Functionality TODO - Features to Copy from OpenCode

This document identifies features from OpenCode that should be adapted for Claude Orchestrator.

---

## Priority Legend
- **P0** - Critical / Must Have
- **P1** - High Priority
- **P2** - Medium Priority
- **P3** - Nice to Have

---

## 1. Session Management Enhancements

### 1.1 Session Forking (P1)
**What**: Allow forking a session at any message point to create a new branch of conversation
**OpenCode Reference**: `/packages/opencode/src/session/index.ts` - `fork()` method
**Why**: Enables experimentation without losing the original conversation thread
**Implementation Notes**:
- Copy message history up to specified point
- Create new session with parent reference
- Track lineage for UI display

### 1.2 Session Sharing (P2)
**What**: Generate shareable URLs for sessions
**OpenCode Reference**: `/packages/opencode/src/session/index.ts` - `share()` / `unshare()` methods
**Why**: Allows sharing interesting AI conversations with team members
**Implementation Notes**:
- Need backend service or static export
- Consider privacy/security implications

### 1.3 Session Archiving (P2)
**What**: Archive old sessions to reduce clutter while preserving history
**OpenCode Reference**: `/packages/opencode/src/session/index.ts` - archive timestamps
**Why**: Better organization for long-term usage
**Implementation Notes**:
- Add archived flag to instance types
- Filter archived from main list
- Archive view/restore functionality

### 1.4 Session Export/Import (P1)
**What**: Export sessions to JSON/Markdown and import back
**OpenCode Reference**: `/packages/opencode/src/cli/cmd/export.ts`, `/packages/opencode/src/cli/cmd/import.ts`
**Why**: Backup, sharing, and migration between machines
**Implementation Notes**:
- Define export format (JSON with messages, metadata)
- Support markdown export for readability
- Handle file attachments in export

### 1.5 Usage Tracking & Cost Display (P1)
**What**: Track token usage with cost calculation per session
**OpenCode Reference**: `/packages/opencode/src/session/index.ts` - usage tracking with cache awareness
**Why**: Users need visibility into API costs
**Implementation Notes**:
- Track input/output tokens per message
- Calculate costs based on model pricing
- Display running total in UI
- Cache-aware token counting

---

## 2. Multi-Agent System

### 2.1 Agent Profiles/Modes (P0)
**What**: Define multiple agent profiles with different permissions and prompts
**OpenCode Reference**: `/packages/opencode/src/agent/agent.ts`, `/packages/opencode/src/agent/native/`
**Why**: Different tasks need different capabilities (e.g., "Plan" mode for read-only exploration)
**Implementation Notes**:
- Agent configuration: name, description, permissions, prompt, model override
- Built-in agents: Build (full access), Plan (read-only)
- Tab key to toggle between agents
- Color-coded agent indicators

### 2.2 Subagent Spawning (P1)
**What**: Primary agent can spawn subagents for specialized tasks
**OpenCode Reference**: `/packages/opencode/src/agent/agent.ts` - `mode: "subagent"`
**Why**: Complex tasks benefit from delegation to specialized agents
**Implementation Notes**:
- Already have orchestration protocol, need to refine
- Link subagents to parent sessions
- Track subagent task completion

---

## 3. Permission & Security System

### 3.1 Granular File Permissions (P0)
**What**: Pattern-based file access control (allow/deny/ask per path pattern)
**OpenCode Reference**: `/packages/opencode/src/permission/` - PermissionNext system
**Why**: Security - prevent AI from reading/writing sensitive files
**Implementation Notes**:
- Permission types: read, edit, bash, question, external_directory
- Decisions: allow, deny, ask
- Wildcard pattern matching (e.g., `*.env` → ask)
- Default rules + user overrides

### 3.2 Bash Command Validation (P1)
**What**: Validate and potentially block dangerous bash commands
**OpenCode Reference**: `/packages/opencode/src/permission/arity.ts` - command injection prevention
**Why**: Prevent accidental or malicious destructive commands
**Implementation Notes**:
- Tree-sitter parsing for bash validation
- Arity system for command structure validation
- Configurable allow/block patterns

### 3.3 Environment Variable Protection (P1)
**What**: Protect .env files and secrets from being read/exposed
**OpenCode Reference**: `/packages/opencode/src/permission/` - `.env*` file handling
**Why**: Prevent accidental exposure of API keys and secrets
**Implementation Notes**:
- Default "ask" permission for .env files
- Redaction option for sensitive values
- Audit log for secret access

---

## 4. Tool System Enhancements

### 4.1 Multi-Edit Tool (P1)
**What**: Batch edit multiple files in a single operation
**OpenCode Reference**: `/packages/opencode/src/tool/multiedit.ts`
**Why**: Efficiency for refactoring operations that touch many files
**Implementation Notes**:
- Array of edit operations
- Atomic success/failure
- Preview before applying

### 4.2 Web Search Tool (P2)
**What**: Search the web for current information
**OpenCode Reference**: `/packages/opencode/src/tool/websearch.ts`
**Why**: AI knowledge cutoff means it needs web access for current info
**Implementation Notes**:
- Integration with search API
- Result summarization
- Rate limiting

### 4.3 Web Fetch Tool (P2)
**What**: Fetch and process web page content
**OpenCode Reference**: `/packages/opencode/src/tool/webfetch.ts`
**Why**: Read documentation, articles, code examples from URLs
**Implementation Notes**:
- HTML to markdown conversion
- AI processing of content
- Caching for performance

### 4.4 LSP Integration Tool (P1)
**What**: Language Server Protocol integration for code intelligence
**OpenCode Reference**: `/packages/opencode/src/lsp/`, `/packages/opencode/src/tool/lsp.ts`
**Why**: Better code understanding - definitions, references, symbols
**Implementation Notes**:
- Multi-server management (TypeScript, Python, Rust, Go)
- Symbol resolution (workspace & document)
- Definition/reference finding
- Diagnostics collection

### 4.5 TODO Management Tool (P2)
**What**: Built-in TODO tracking within sessions
**OpenCode Reference**: `/packages/opencode/src/tool/todo.ts` - TodoWriteTool, TodoReadTool
**Why**: Track tasks and progress within complex sessions
**Implementation Notes**:
- Session-scoped TODO lists
- Status tracking (pending, in-progress, done)
- UI display of TODOs

### 4.6 Plan Mode Tools (P1)
**What**: Enter/exit plan mode for read-only exploration before making changes
**OpenCode Reference**: `/packages/opencode/src/tool/plan.ts` - PlanEnterTool, PlanExitTool
**Why**: Safer exploration - understand before modifying
**Implementation Notes**:
- Plan mode restricts write operations
- Approval workflow before exiting plan mode
- Visual indicator of current mode

### 4.7 Code Search (Semantic) (P3)
**What**: Semantic code search beyond grep
**OpenCode Reference**: `/packages/opencode/src/tool/codesearch.ts` - Exa-powered
**Why**: Find code by meaning, not just text matching
**Implementation Notes**:
- External API integration (Exa)
- Index codebase for semantic search
- Feature flag gated

---

## 5. Provider & Model System

### 5.1 Multi-Provider Support (P0)
**What**: Support multiple AI providers beyond Claude
**OpenCode Reference**: `/packages/opencode/src/provider/` - 20+ providers
**Why**: Flexibility, cost optimization, feature access
**Providers to Add**:
- OpenAI / OpenAI-compatible
- Google (Gemini, Vertex)
- Amazon Bedrock
- Azure
- Mistral
- Groq
- Local models (Ollama)

### 5.2 Dynamic Model Discovery (P1)
**What**: Automatically discover available models from providers
**OpenCode Reference**: `/packages/opencode/src/provider/models.ts`
**Why**: Keep model list current without manual updates
**Implementation Notes**:
- API-based model listing
- Cache model capabilities
- Cost/pricing tracking

### 5.3 Model Pricing & Cost Tracking (P1)
**What**: Track costs per model with input/output token pricing
**OpenCode Reference**: `/packages/opencode/src/provider/models.ts` - cost tracking
**Why**: Budget management and cost optimization
**Implementation Notes**:
- Price per token (input/output/cache)
- Running cost calculation
- Budget alerts

---

## 6. Configuration System

### 6.1 Hierarchical Configuration (P1)
**What**: Project > User > Default configuration hierarchy
**OpenCode Reference**: `/packages/opencode/src/config/` - config priority system
**Why**: Project-specific settings without global changes
**Implementation Notes**:
- Project config in working directory
- User config in app data
- Remote/organization config support
- JSONC format with comments

### 6.2 Remote Configuration (P2)
**What**: Load configuration from well-known endpoints
**OpenCode Reference**: `/packages/opencode/src/config/` - well-known endpoint
**Why**: Organization-wide defaults and policies
**Implementation Notes**:
- .well-known/opencode.json endpoint
- Merge with local config
- Cache with refresh

---

## 7. Command System

### 7.1 Custom Commands/Templates (P1)
**What**: User-defined command templates with placeholders
**OpenCode Reference**: `/packages/opencode/src/command/` - template system
**Why**: Automate common prompts and workflows
**Implementation Notes**:
- Template format with $1, $2, $ARGUMENTS placeholders
- Description and hint generation
- Command discovery in config

### 7.2 Built-in Commands (P2)
**What**: Standard commands like init, review
**OpenCode Reference**: `/packages/opencode/src/command/native/`
**Why**: Common operations shouldn't require custom setup
**Built-in Commands**:
- `/init` - Create/update AGENTS.md
- `/review` - Review changes (commit/branch/PR)
- `/commit` - Create git commit
- `/pr` - Create pull request

---

## 8. MCP Integration

### 8.1 MCP Server Support (P1)
**What**: Full MCP (Model Context Protocol) server integration
**OpenCode Reference**: `/packages/opencode/src/mcp/`
**Why**: Extend capabilities with external tools and resources
**Implementation Notes**:
- OAuth provider support
- MCP prompt integration
- Resource discovery
- Dynamic tool injection from MCP servers

---

## 9. UI/UX Enhancements

### 9.1 Processing Spinner & Loading States (P0)
**What**: Visual spinner/loading indicator shown in the output area while Claude is processing
**OpenCode Reference**: `/packages/ui/src/components/spinner.tsx`
**Why**: Current app only shows a small pulsing dot in instance list - users need clear feedback that work is happening
**Implementation Notes**:
- Custom animated SVG spinner with 4x4 grid of pulsing squares
- Randomized animation delays for organic feel
- Show prominently in output area while status is "busy"
- Current `StatusIndicatorComponent` only shows 12px dot in instance list - insufficient

**Relevant Current Code**:
- `/src/renderer/app/features/instance-list/status-indicator.component.ts` - existing pulsing dot (needs enhancement)
- `/src/renderer/app/features/instance-detail/output-stream.component.ts` - where spinner should appear

### 9.2 Tool-Aware Status Messages (P0)
**What**: Display human-readable status based on what tool Claude is currently executing
**OpenCode Reference**: `/packages/ui/src/components/session-turn.tsx` (lines 37-74) - `computeStatusFromPart()`
**Why**: "Let me explore the codebase" with no further feedback is poor UX - users should see "Searching the codebase", "Gathering context", etc.
**Implementation Notes**:
- Map tool names to user-friendly messages:
  - `read` → "Gathering context"
  - `grep`, `glob`, `list` → "Searching the codebase"
  - `edit`, `write` → "Making edits"
  - `bash` → "Running commands"
  - `task` → "Delegating work"
  - `todowrite`, `todoread` → "Planning next steps"
  - `webfetch` → "Searching the web"
- Extract reasoning topic: "Thinking · {topic}" from `**topic**` markdown
- Parse NDJSON output to detect current tool execution

**Relevant Current Code**:
- `/src/main/cli/ndjson-parser.ts` - already parsing tool_use events
- `/src/main/cli/claude-cli-adapter.ts` - emits 'output' events with tool info
- `/src/renderer/app/core/state/instance.store.ts` - needs new `currentActivity` signal

### 9.3 Status Update Debouncing (P1)
**What**: Debounce rapid status changes to prevent visual flickering
**OpenCode Reference**: `/packages/ui/src/components/session-turn.tsx` (lines 438-460)
**Why**: Status can change rapidly (thinking → tool → thinking → text) causing jarring UI updates
**Implementation Notes**:
- 2.5s debounce for status text changes (OpenCode pattern)
- Immediate update if 2.5s+ since last change
- Queue pending updates for later
- Clear queue on completion

**Relevant Current Code**:
- `/src/renderer/app/core/services/update-batcher.service.ts` - existing 50ms batching (needs status-specific debounce)

### 9.4 Text Streaming Throttling (P1)
**What**: Throttle text rendering during streaming to prevent excessive re-renders
**OpenCode Reference**: `/packages/ui/src/components/message-part.tsx` (lines 104-143) - `createThrottledValue()`
**Why**: Streaming text can update 50-100+ times/second causing UI thrashing
**Implementation Notes**:
- 100ms throttle for streaming text updates
- Immediate render on completion
- Use `requestAnimationFrame` or timer-based throttling

**Relevant Current Code**:
- `/src/renderer/app/features/instance-detail/output-stream.component.ts` - currently renders all updates immediately

### 9.5 Parallel Task Visualization (P1)
**What**: Clear visual indication when multiple child processes are running in parallel
**OpenCode Reference**: N/A (orchestrator-specific feature)
**Why**: User expected parallel exploration of two codebases but couldn't tell if it was happening
**Implementation Notes**:
- Show spawned children in a collapsible panel
- Status indicator per child (spinner + activity message)
- Tree view showing parent → children relationship
- Aggregate status: "Running 2 parallel tasks"

**Root Cause Analysis**: The orchestrator relies on Claude deciding to spawn parallel children via `:::ORCHESTRATOR_COMMAND:::`. If Claude chooses to run tasks sequentially or uses a single agent, no parallelization occurs. Consider:
- More explicit orchestration prompts encouraging parallelization
- UI affordance to suggest "Run in parallel?" for multi-item tasks
- Visual feedback that shows whether parallelization is happening

**Relevant Current Code**:
- `/src/main/orchestration/orchestration-protocol.ts` - defines `spawn_child` command
- `/src/main/orchestration/orchestration-handler.ts` - executes spawn commands
- `/src/main/instance-manager.ts` - manages child instances

### 9.6 Keybinding System (P1)
**What**: Configurable keybindings with leader key support
**OpenCode Reference**: `/packages/opencode/src/util/keybind.ts`
**Why**: Power user productivity
**Implementation Notes**:
- Vim-style leader key
- Modifier combinations
- Customizable bindings
- Display in help/settings

### 9.2 External Editor Integration (P2)
**What**: Open files in user's preferred editor
**OpenCode Reference**: `/packages/opencode/src/cli/cmd/tui/util/editor.ts`
**Why**: Complex edits are easier in full IDE
**Implementation Notes**:
- Detect $EDITOR/$VISUAL
- Support VS Code, vim, etc.
- File change detection on return

### 9.3 Markdown Rendering (P1)
**What**: Rich markdown rendering with syntax highlighting
**OpenCode Reference**: `/packages/ui/src/` - Shiki for syntax highlighting
**Why**: Better readability of AI responses
**Implementation Notes**:
- Code block syntax highlighting (Shiki)
- Diff visualization
- Math rendering (KaTeX)
- Copy code button

### 9.4 Diff Visualization (P1)
**What**: Show file changes as visual diffs
**OpenCode Reference**: `/packages/ui/src/` - @pierre/diffs
**Why**: Easier to review AI-proposed changes
**Implementation Notes**:
- Side-by-side diff view
- Inline diff view
- Accept/reject per change

### 9.5 Agent Color Coding (P2)
**What**: Color-code messages by agent/mode
**OpenCode Reference**: `/packages/opencode/src/agent/agent.ts` - color property
**Why**: Visual distinction between different agents
**Implementation Notes**:
- Agent-specific colors
- Mode indicators (build vs plan)
- Status bar showing current agent

---

## 10. File & Project System

### 10.1 File Watcher (P2)
**What**: Watch for file changes and notify AI
**OpenCode Reference**: `/packages/opencode/src/file/watcher.ts`
**Why**: Keep AI aware of external changes
**Implementation Notes**:
- Gitignore-aware watching
- Debounced notifications
- Event publishing

### 10.2 VCS Integration (P1)
**What**: Git integration for status, diff, commit
**OpenCode Reference**: `/packages/opencode/src/project/vcs.ts`
**Why**: AI should understand version control context
**Implementation Notes**:
- Git status awareness
- Commit/branch information
- Diff generation for review commands

### 10.3 Ripgrep Integration (P1)
**What**: Fast file searching with ripgrep
**OpenCode Reference**: `/packages/opencode/src/file/ripgrep.ts`
**Why**: Performance for large codebases
**Implementation Notes**:
- Already may use grep, ensure ripgrep specifically
- Respect gitignore
- Result formatting

---

## 11. Snapshot & Revert System

### 11.1 File Snapshots (P1)
**What**: Snapshot files before AI modifications
**OpenCode Reference**: `/packages/opencode/src/snapshot/`
**Why**: Easy revert if AI makes mistakes
**Implementation Notes**:
- Automatic snapshot on edit
- Diff storage (not full files)
- Per-session snapshot history

### 11.2 Revert Capability (P1)
**What**: Revert file changes to previous state
**OpenCode Reference**: `/packages/opencode/src/snapshot/` - revert functionality
**Why**: Undo AI changes easily
**Implementation Notes**:
- Single file revert
- Batch revert (all session changes)
- Visual diff before revert

---

## 12. Plugin & Extension System

### 12.1 Custom Tool Plugins (P2)
**What**: Load custom tools from config directories
**OpenCode Reference**: `/packages/opencode/src/tool/registry.ts` - plugin discovery
**Why**: Extensibility for custom workflows
**Implementation Notes**:
- Scan `{tool,tools}/*.{js,ts}` directories
- Dynamic import
- Zod schema validation
- Tool registration API

### 12.2 Provider Plugins (P3)
**What**: Add custom AI providers via plugins
**OpenCode Reference**: `/packages/plugin/` - provider integrations
**Why**: Support for custom/internal AI services
**Implementation Notes**:
- Provider interface definition
- Authentication handling
- Model capability declaration

---

## 13. Logging & Debugging

### 13.1 Structured Logging (P2)
**What**: Service-based logging with levels
**OpenCode Reference**: `/packages/opencode/src/util/log.ts`
**Why**: Debugging and troubleshooting
**Implementation Notes**:
- Per-subsystem logging
- Log levels (DEBUG, INFO, WARN, ERROR)
- File-based logging option
- Log viewer in UI

### 13.2 Debug Commands (P2)
**What**: Debug subcommands for troubleshooting
**OpenCode Reference**: `/packages/opencode/src/cli/cmd/debug/`
**Why**: Diagnose issues without code changes
**Debug Targets**:
- Agent configuration
- Config resolution
- File operations
- LSP status
- Ripgrep behavior

---

## 14. Statistics & Analytics

### 14.1 Usage Statistics (P2)
**What**: Track and display usage statistics
**OpenCode Reference**: `/packages/opencode/src/cli/cmd/stats.ts`
**Why**: Understand usage patterns and costs
**Metrics**:
- Total sessions
- Total tokens used
- Costs by provider/model
- Most used tools

---

## Implementation Order Recommendation

### Phase 0 (Immediate UX Improvements) ✅ COMPLETE
1. ✅ Processing Spinner & Loading States (9.1) - `processing-spinner.component.ts`
2. ✅ Tool-Aware Status Messages (9.2) - `activity-status.component.ts`, `currentActivity`/`currentTool` tracking
3. ✅ Status Update Debouncing (9.3) - `activity-debouncer.service.ts` (2.5s debounce)
4. ✅ Text Streaming Throttling (9.4) - `throttleOutput()` in instance.store (100ms batches)
5. ✅ Parallel Task Visualization (9.5) - `child-instances-panel.component.ts`
6. ✅ Conversation History Sidebar - `history-sidebar.component.ts`, `history-manager.ts` (bonus feature)

### Phase 1 (Foundation)
6. Multi-Provider Support (5.1) - P0
7. Agent Profiles/Modes (2.1) - P0
8. Granular File Permissions (3.1) - P0
9. Usage Tracking & Cost Display (1.5) - P1

### Phase 2 (Core Features)
10. Session Forking (1.1) - P1
11. Session Export/Import (1.4) - P1
12. Hierarchical Configuration (6.1) - P1
13. Custom Commands (7.1) - P1
14. Plan Mode Tools (4.6) - P1

### Phase 3 (Enhanced Tooling)
15. LSP Integration (4.4) - P1
16. Multi-Edit Tool (4.1) - P1
17. VCS Integration (10.2) - P1
18. Ripgrep Integration (10.3) - P1
19. File Snapshots & Revert (11.1, 11.2) - P1

### Phase 4 (UX Polish)
20. Markdown Rendering (9.8) - P1
21. Diff Visualization (9.9) - P1
22. Keybinding System (9.6) - P1
23. Bash Command Validation (3.2) - P1

### Phase 5 (Extended Features)
24. MCP Integration (8.1) - P1
25. Model Discovery (5.2) - P1
26. Session Sharing (1.2) - P2
27. Web Search/Fetch (4.2, 4.3) - P2
28. TODO Management (4.5) - P2
29. Plugin System (12.1) - P2

---

## Notes

- All file paths reference the OpenCode codebase at `/Users/suas/work/orchestrat0r/opencode`
- Claude Orchestrator codebase is at `/Users/suas/work/orchestrat0r/claude-orchestrator`
- OpenCode uses TypeScript/Bun while Orchestrator uses TypeScript/Angular/Electron
- Some features may need significant adaptation for the Electron architecture
- Consider OpenCode's Solid.js UI components - may need rewrite for Angular
