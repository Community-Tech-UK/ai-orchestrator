# Claude Code Instructions for AI Orchestrator

## Project Overview

This is an Electron + Angular application that orchestrates multiple Claude CLI instances. It provides multi-agent coordination, verification, debate systems, and memory management.

## Tech Stack

- **Frontend**: Angular 21 with signals-based state management
- **Backend**: Electron (Node.js) with TypeScript
- **CLI Integration**: Claude CLI adapters for spawning AI instances
- **Build**: Angular CLI + Electron Builder
- **Testing**: Vitest

## Development Commands

```bash
# Development
npm start                    # Start Electron app in dev mode
npm run build               # Build for production

# Quality Checks (ALWAYS run after changes)
npx tsc --noEmit            # TypeScript compilation check
npm run lint                # ESLint check (uses ng lint)
npm run test                # Run tests (uses vitest)
```

## Implementation Requirements

### After Making Code Changes

**ALWAYS verify your changes compile and lint correctly:**

1. Run `npx tsc --noEmit` - Must pass with no errors
2. Run `npx tsc --noEmit -p tsconfig.spec.json` - Spec/test files must also compile
3. Run `npm run lint` or `npx eslint <modified-files>` - Fix any errors introduced
4. If tests exist for modified code, run them

### Code Style

- Use `const` instead of `let` when variables aren't reassigned
- Use generic type arguments on constructors, not variable declarations:
  ```typescript
  // Good
  private cache = new Map<string, Entry>();

  // Bad
  private cache: Map<string, Entry> = new Map();
  ```
- Remove unused imports
- Don't use type annotations when types can be inferred from literals

## Architecture Notes

### Key Directories

- `src/main/` - Electron main process (Node.js)
- `src/renderer/` - Angular frontend
- `src/shared/` - Shared types and utilities
- `src/preload/` - Electron preload scripts

### Multi-Agent Systems

The orchestrator has several multi-agent coordination systems:

1. **Multi-Verification** (`src/main/orchestration/multi-verify-coordinator.ts`)
   - Spawns multiple agents to verify responses
   - Uses embedding-based semantic clustering
   - Caches results for efficiency

2. **Debate System** (`src/main/orchestration/debate-coordinator.ts`)
   - Multi-round debates between agents
   - Critique and defense rounds
   - Consensus synthesis

3. **Skills System** (`src/main/skills/`)
   - Progressive skill loading
   - Built-in orchestrator skills in `src/main/skills/builtin/`
   - Skills must be in subdirectories with `SKILL.md` files

### Known Integration Gaps

The following event emitters have no listeners wired up (by design - allows extensibility):
- `debate:generate-response`, `debate:generate-critiques`, `debate:generate-defense`, `debate:generate-synthesis`
- `verification:invoke-agent`

These emit events expecting external LLM invocation handlers to be connected.

### CLAUDE.md Loading

Instance lifecycle automatically loads CLAUDE.md files:
- Global: `~/.claude/CLAUDE.md`
- Project: `.claude/CLAUDE.md`

Content is prepended to instance system prompts.

## Bigchange Implementation Process

When implementing features from `bigchange_*.md` files:

1. **Read the plan thoroughly** before starting
2. **Check existing code** - features may already be partially implemented
3. **Implement incrementally** - complete one phase at a time
4. **Verify each change**:
   - `npx tsc --noEmit` - TypeScript must pass
   - `npx tsc --noEmit -p tsconfig.spec.json` - Spec files must also compile
   - `npm run lint` - Fix any lint errors
5. **Audit integration** - Ensure new code is actually used:
   - Imports are added where needed
   - Singletons are initialized
   - Event listeners are connected
   - IPC handlers are registered

## Common Patterns

### Singleton Services (Main Process)

The main process uses lazy singleton pattern with helper getters:

```typescript
export class MyService {
  private static instance: MyService;

  static getInstance(): MyService {
    if (!this.instance) {
      this.instance = new MyService();
    }
    return this.instance;
  }

  // For testing: reset singleton state
  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.cleanup?.();
      (this.instance as any) = undefined;
    }
  }

  private constructor() {}
}

// Convenience getter (preferred for imports)
export function getMyService(): MyService {
  return MyService.getInstance();
}
```

### Structured Logging

Use the LogManager for structured logging with subsystem context:

```typescript
import { getLogger } from '../logging/logger';

const logger = getLogger('MyService');

// Usage
logger.info('Operation completed', { key: 'value' });
logger.warn('Potential issue', { context: data });
logger.error('Operation failed', error, { instanceId });
```

### Dependency Injection Patterns

**Main Process (Node.js):**
- Singletons accessed via `getXxx()` helper functions
- Services can depend on other singletons via lazy initialization
- Use constructor injection for dependencies passed from parent

```typescript
// Good: Use helper function for singleton access
import { getLogManager } from '../logging/logger';
import { getSupervisorTree } from '../process/supervisor-tree';

class MyCoordinator {
  private logger = getLogManager().getLogger('MyCoordinator');
  private tree = getSupervisorTree();
}

// Good: Accept dependencies from parent for flexibility
class InstanceLifecycleManager {
  constructor(private deps: LifecycleDependencies) {}
}
```

**Renderer (Angular):**
- Use Angular's `inject()` function in components and services
- Stores are injectable services with signal-based state

```typescript
@Component({...})
export class MyComponent {
  private store = inject(InstanceStore);  // DI via inject()
  data = this.store.data;  // Signals for reactivity
}

@Injectable({ providedIn: 'root' })
export class MyService {
  private http = inject(HttpClient);
}
```

### IPC Handler Registration

IPC handlers are registered in `src/main/ipc/` and exposed via `src/preload/preload.ts`.

All IPC payloads should be validated with Zod schemas (see `src/shared/validation/ipc-schemas.ts`):

```typescript
import { validateIpcPayload, InstanceCreatePayloadSchema } from '../../../shared/validation/ipc-schemas';

ipcMain.handle(IPC_CHANNELS.INSTANCE_CREATE, async (_event, payload) => {
  const validated = validateIpcPayload(InstanceCreatePayloadSchema, payload, 'INSTANCE_CREATE');
  // Use validated data...
});
```

### Angular Components

Use standalone components with signals for state management:
```typescript
@Component({
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,  // Always use OnPush
  // ...
})
export class MyComponent {
  private store = inject(MyStore);
  data = this.store.data;  // Signal from store

  // Computed values
  filteredData = computed(() => this.data().filter(x => x.active));
}
```

### Testing Singletons

For unit tests, reset singletons before each test:

```typescript
import { SupervisorTree } from '../process/supervisor-tree';
import { EmbeddingService } from '../orchestration/embedding-service';

beforeEach(() => {
  SupervisorTree._resetForTesting();
  EmbeddingService._resetForTesting();
});
```
