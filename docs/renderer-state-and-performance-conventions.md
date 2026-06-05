# Renderer State and Performance Conventions

Conventions for Angular component state management and change-detection
performance in the AI Orchestrator renderer. Ground rules come from the
project's `angular.md` and `AGENTS.md`; this document adds the "why" and
the anti-pattern catalogue.

---

## 1. Change detection strategy

**Every component must use `ChangeDetectionStrategy.OnPush`.**

With `OnPush`, Angular skips a component's template evaluation unless:

1. A signal the template reads has been notified as changed, **or**
2. An `input()` reference changed, **or**
3. An async pipe emitted, **or**
4. `ChangeDetectorRef.markForCheck()` was called explicitly.

Without `OnPush`, Angular re-evaluates the template on every event that touches
any ancestor. In a complex UI with many live data sources this becomes O(N)
work per event, making the app sluggish and tests misleading.

```typescript
// Required
@Component({
  selector: 'app-my-widget',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `…`,
})
export class MyWidgetComponent { … }
```

---

## 2. Signals as the default state container

Use `signal()` for all mutable component-local state. Signals integrate
directly with Angular's change detection: when a signal changes, Angular
marks only the views that read it as dirty.

```typescript
// Good — signals, component stays OnPush-friendly
readonly count = signal(0);
readonly open = signal(false);

// Bad — plain property, breaks OnPush because Angular cannot detect the change
count = 0;
open = false;
```

Signals are readable from templates and from `computed()` without any ceremony.
They replace `BehaviorSubject`-backed properties for component state.

---

## 3. Derived state with `computed()`

Use `computed()` for any value that is derived from one or more other signals.
Angular memoises the result and only re-evaluates when a dependency changes.

```typescript
// Good
readonly items = signal<string[]>([]);
readonly itemCount = computed(() => this.items().length);
readonly hasItems = computed(() => this.items().length > 0);

// Bad — getter re-evaluates every CD cycle, no memoisation
get itemCount() { return this.items().length; }
```

`computed()` also composes: a `computed()` that reads another `computed()` is
re-evaluated only when the transitive dependency chain changes.

---

## 4. Template expressions: no recomputed function calls

A plain method call in a template is re-executed on every change detection
pass for the component — even when nothing relevant has changed.

```typescript
// Bad — tooltip() runs on every CD pass
template: `<button [title]="tooltip()">…</button>`
tooltip(): string { return this.items().map(…).join('\n'); }

// Good — computed() is memoised
readonly tooltipText = computed(() => this.items().map(…).join('\n'));
template: `<button [title]="tooltipText()">…</button>`
```

If a plain method is unavoidable (e.g. a public API called by the host), keep
it pure and fast — never fetch, sort, or filter inside it.

**Signals called in templates are fine.** `signal()` and `computed()` reads
are tracked by the reactivity graph; Angular knows exactly which signals a
template depends on.

---

## 5. Dependency injection with `inject()`

Always use `inject()`. Never use constructor parameter injection.

```typescript
// Good
private readonly store = inject(MyStore);
private readonly router = inject(Router);

// Bad (violates project conventions)
constructor(private store: MyStore, private router: Router) {}
```

---

## 6. Signal inputs and outputs

Use the `input()` / `output()` signal APIs. Do not use `@Input()` / `@Output()`
decorators.

```typescript
// Good
readonly label = input.required<string>();
readonly count = input(0);
readonly selected = output<string>();

// Bad
@Input() label!: string;
@Output() selected = new EventEmitter<string>();
```

`input()` returns a read-only signal, so the template can read it as `label()`
and derive `computed(() => label().toUpperCase())` without any extra plumbing.

---

## 7. Converting RxJS streams at the boundary

Keep RxJS inside services and stores. At the component boundary, convert
observables to signals with `toSignal()`.

```typescript
// Good — signal in the component, observable stays in the service
readonly status = toSignal(this.statusService.status$, { initialValue: 'idle' });

// Acceptable when you need async control flow in a service
readonly status$ = this.statusService.status$; // service stays RxJS
```

Do not expose `BehaviorSubject` or `Subject` from services that angular
components inject directly. Expose `readonly signal` properties instead.
Writable signals stay private; mutation goes through named methods.

```typescript
// Good service pattern
private readonly _items = signal<Item[]>([]);
readonly items = this._items.asReadonly();

addItem(item: Item): void { this._items.update(list => [...list, item]); }
```

---

## 8. When to use `effect()`

`effect()` is for **side effects triggered by signal changes**: logging,
calling a non-signal API, syncing to localStorage, etc. It is not a
replacement for `computed()`.

```typescript
// Good — persisting state as a side effect
constructor() {
  effect(() => localStorage.setItem('theme', this.theme()));
}

// Bad — use computed() for derived values, not effect()
effect(() => {
  this.displayLabel.set(this.rawLabel().toUpperCase());
});
```

Avoid creating `effect()` in services unless absolutely necessary — prefer
`computed()` and explicit method calls.

---

## 9. Lazy loading and `@defer`

Use `@defer` for non-critical UI sections: modals, below-the-fold panels,
heavy charts, and any component that imports a large third-party library.

```html
<!-- Good — heavy chart only loaded when visible -->
@defer (on viewport) {
  <app-echarts-chart [data]="chartData()" />
}

<!-- Acceptable — full content replaced by skeleton while loading -->
@defer {
  <app-expensive-panel />
} @loading {
  <app-skeleton />
}
```

---

## 10. Common anti-patterns

| Anti-pattern | Impact | Fix |
|---|---|---|
| `Default` CD strategy | Re-renders on every zone event | Add `OnPush` |
| Method calls in templates | Re-runs on every CD pass | Use `computed()` |
| `@Input()` / `@Output()` decorators | See project `angular.md` | Use `input()` / `output()` |
| Constructor DI | See project `angular.md` | Use `inject()` |
| Exposing writable signal from service | Allows external mutation | Use `.asReadonly()` |
| `BehaviorSubject` for component state | No integration with CD | Use `signal()` |
| `effect()` for derived values | Runs async, adds complexity | Use `computed()` |
| Subscribing to observables in constructor without cleanup | Memory leak | Use `toSignal()` or `takeUntilDestroyed()` |

---

## Related

- `docs/shell-component-standards.md` — shell component checklist
- `src/renderer/app/testing/render-count-harness.ts` — utility for writing
  render-count tests
- Project `angular.md` — canonical rule list
