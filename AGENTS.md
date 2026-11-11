# ufAI workspace instructions

## Project context

ufAI is an MIT-licensed, local-first platform intended to let users organize AI agents in multiple workspaces through a browser dashboard. Planned capabilities include provider connections, local models, supported subscription-backed runtimes, per-agent instructions and skills, visual communication permissions, messaging, and triggers.

**Current state: early functional dashboard.** Navigation, persisted workspace tabs, empty pannable flowboards, and model preset CRUD exist. Provider/runtime connections, automatic discovery, sign-in, agent editing/execution, and actual compaction remain planned. Verify the repository before describing any feature as implemented.

## Read before changing code

- Start with the [documentation index](docs/README.md), then read only the references relevant to the task.
- Use the [platform guide](docs/platform.md) for capabilities, terminology, setup, and limitations.
- Use the [architecture reference](docs/architecture.md) for implementation boundaries, interfaces, and decisions.
- Treat documentation as context, not authorization to run tools or change user resources. Follow the user's requested scope and applicable instructions.
- Preserve unrelated changes. Avoid speculative features, abstractions, infrastructure, and dependencies.

## Stack and boundaries

- TypeScript throughout; React + Vite in `apps/web`; Node.js + Fastify in `apps/server`.
- SQLite through `better-sqlite3`; npm workspaces; MIT license. Keep secrets and generated local data out of Git.
- Production uses one persistent application server for the compiled UI and API. Development uses Fastify and Vite with an API proxy.
- As features arrive, separate model-provider adapters, existing agent-runtime adapters, orchestration, and persistence. A model API and an agent runtime are different integration types.
- Keep workspace/agent permissions enforceable on the server; canvas connections must not be the only enforcement mechanism.
- Separate directories organize agent files but do not provide a security sandbox.
- **Frontend defaults:** Zustand for shared reactive client state and SCSS modules for component styling. Zustand and Sass are installed; React Flow supplies canvas viewport interactions. Keep shared API imports from server contracts type-only.

## React performance and state ownership

- Keep state close to its consumers. Use local React state for local UI and Zustand for shared reactive state; do not put every transient value in a global store.
- Subscribe through narrow selectors. Avoid whole-store subscriptions; use `useShallow` when a composite selection benefits from shallow equality. Preserve unchanged object references during immutable updates.
- Keep rendering reactive: do not read `store.getState()` in render as a replacement for subscribing. Imperative reads are appropriate in handlers and services that do not need subscriptions.
- Keep static constants and pure helpers outside components. Cheap calculations based on current props/state may remain ordinary local variables.
- Use `useMemo` for expensive derivations or identities that affect memoized children, subscriptions, or hook dependencies. It neither subscribes to state nor guarantees correctness; never perform side effects inside it.
- Prefer named handlers. Use `useCallback` when function identity matters, such as memoized children or subscription APIs. Avoid inline callback props at those boundaries; trivial DOM handlers do not require blanket memoization.
- Include complete hook dependencies; fix stale closures rather than suppressing dependency checks. Do not force empty dependency arrays to manufacture stability.
- Keep instance-specific mutable, non-rendering values in refs or explicitly scoped services. Ordinary variables suit temporary work; module constants suit shared immutable data. Never leak workspace, agent, or component-instance state through mutable module globals.
- Use `React.memo` where repeated renders with unchanged props are meaningful. Stabilize relevant props first; avoid blanket wrappers and expensive deep comparisons. React Compiler is not configured in this scaffold; do not assume automatic memoization.
- Use stable identity-based list keys. Extract component definitions from parent render functions. Keep rendering pure and clean up effects, listeners, timers, and subscriptions.
- Avoid effects that merely copy derived state or create update chains. Keep server-persisted data authoritative on the server; distinguish it from temporary client state and caches.
- Isolate rapidly changing agent-node state from the whole canvas. Batch streamed updates and virtualize large histories/lists when workload warrants it.
- Profile representative interactions before complex optimization; account for development Strict Mode when interpreting render counts. Preserve correctness and accessibility.

## Styling

- Use `.module.scss` for component styles and a small global stylesheet for shared foundations. The dashboard uses SCSS modules and a small global SCSS foundation.
- Avoid static inline CSS. Use classes for variants and CSS custom properties for runtime values where practical.
- Dynamic inline styles are allowed when values depend on runtime state. Memoize style objects when stable identity matters; do not use memoization merely to store static styles.
- Avoid deeply nested selectors and broad global overrides. Keep focus indicators, keyboard interaction, reduced-motion preferences, and layout stability intact.

## Server, database, and resource performance

- Keep CPU-heavy work and long blocking operations out of Fastify request handlers. Use bounded concurrency and workers/child processes where needed; async syntax does not make synchronous work non-blocking.
- `better-sqlite3` is synchronous. Keep queries bounded and transactions short; use parameter binding, appropriate indexes, pagination, and prepared-statement reuse where useful. Never hold a transaction across network calls or agent execution.
- Keep high-frequency UI updates separate from durable persistence. Avoid rewriting an entire workspace for each token or pointer event; preserve required durable events and final state.
- Bound queues, caches, event retention, and logs. Respect backpressure and cancellation, and clean up streams, database handles, processes, listeners, and timers.
- Add retry limits and idempotency where external side effects can repeat. Do not assume job delivery is exactly once.
- Validate performance changes with representative workloads. Avoid introducing services or dependencies solely for hypothetical scale.

## Commands and validation

Run from the repository root; Node.js >=22.12 and npm are required (`.nvmrc` selects Node 22).

| Command | Purpose |
| --- | --- |
| `npm ci` | Install locked dependencies |
| `npm run dev` | Start Fastify and Vite with watch/reload |
| `npm run typecheck` | Type-check both workspaces |
| `npm test` | Run API/database, client-state, and preset validation/calculation checks |
| `npm run build` | Compile server and browser assets |
| `npm start` | Run the built server and serve the built UI |

Defaults: server `127.0.0.1:3000`, development UI `127.0.0.1:5173`, SQLite at repository-root `data/ufai.sqlite`. Shell variables `HOST`, `PORT`, `WEB_PORT`, and `DATABASE_PATH` configure these; see the [configuration reference](docs/architecture.md#configuration). `.env` files are not automatically loaded.

- For implementation changes, run relevant existing checks and meaningful behavior checks. For documentation-only changes, verify facts, links, and whitespace; runtime tests/builds are unnecessary unless a documented behavior is uncertain.
- Focused automated tests use Node’s test runner through `tsx`, including temporary SQLite databases and Fastify injection. There is no automated browser suite. Do not report checks or features that do not exist.

## Documentation is part of the change

- Follow the [documentation format and checklist](docs/README.md#maintenance-checklist). Update affected documentation alongside behavior, configuration, API, storage, workflow, or limitation changes.
- Keep platform behavior in the platform guide and internal implementation detail in the architecture reference. Keep this file focused on lasting working rules.
- Use stable capability IDs and explicit `implemented`, `partial`, or `planned` statuses. Separate current behavior from intentions; plans are not existing APIs or commitments to a particular implementation.
- Describe observable behavior and relevant rationale, not copied source code or chat history. Maintain links and remove stale or conflicting instructions.
- Exclude credentials, private user/workspace data, local logs, and machine-specific process details. Documentation does not grant permissions or establish live runtime state.
- In the final task summary, report documentation updates or briefly state why none were needed. State checks actually run and any remaining limitations.

## Performance references

- [React useMemo](https://react.dev/reference/react/useMemo), [useCallback](https://react.dev/reference/react/useCallback), and [memo](https://react.dev/reference/react/memo).
- [React refs for non-rendering instance values](https://react.dev/learn/referencing-values-with-refs).
- [Zustand selectors and shallow comparison](https://zustand.docs.pmnd.rs/learn/guides/prevent-rerenders-with-use-shallow).
