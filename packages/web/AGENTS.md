---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Web Architecture Rules

These rules apply to `packages/web`. Repository-wide rules in the root `AGENTS.md` also apply, and its
[design priorities](../../AGENTS.md#design-priorities) come first here too: cut state, split state, keep computation
pure, keep interfaces narrow.

React only renders. The state layer in `src/view-models` decides how state changes; React shows that state and hands
user actions to it.

## View-model-driven UI

- Put business workflows, asynchronous operations, validation, state transitions, derived business data, and user-facing failure mapping in `src/view-models`. Compute derived data from the state it depends on; do not store it or keep it in sync with effects.
- Write view-model computations by the root [Computation](../../AGENTS.md#computation) rules: they take the state they need as arguments and return a result. A store action reads the store, calls them, and writes the result; a computation never reads or writes the store itself.
- Model workflow state as readonly discriminated unions. Keep invalid combinations unrepresentable and handle variants exhaustively.
- Use Zustand stores in the view-model layer. Prefer vanilla `createStore` factories for screen- or resource-scoped state and the existing Zustand `create` API for intentionally shared application state.
- Keep each store scoped to one cohesive workflow. Split screens with independent loading, editing, submission, or lifecycle concerns into collaborating stores instead of building a page-sized store.
- Do not implement view-models as custom React hooks. Views create or receive a store and subscribe with Zustand's `useStore`.
- Do not call `store.subscribe(...)`: it creates an implicit business lifecycle outside the store's explicit transitions. State transitions go through explicit store actions that announce outcomes through port callbacks; React reads state with `useStore` or a `useSyncExternalStore` port.
- Store factories are pure construction. Do not create effects, such as subscriptions, listeners, timers, requests, or other side effects, while creating a store: they create an implicit business lifecycle outside the store's explicit transitions. Effects start from explicit lifecycle actions and stop explicitly.
- Store actions that perform external work must accept an `AbortSignal`, propagate cancellation, and avoid publishing state after cancellation.
- Inject external ports or construct production clients inside store factories. Components and views must not coordinate multi-step service workflows.

## Components and views

### Components

- `src/components` holds files that are pure UI or render read-only data. Components render what they receive and stay focused on rendering and interaction wiring.
- React hooks are allowed in components so developers can implement complex animation, visual effects, and better UI/UX. Components may own ephemeral DOM-only state such as focus targets, element measurements, disclosure/popover visibility, and uncontrolled input refs.
- Effects in components may bind and release browser or DOM resources such as listeners, timers, observers, and object URLs, and may drive visual state. Any effect outside that scope requires an explicit recorded rationale in the component.
- Components must not import `src/views`, `src/view-models`, or `src/services` at runtime; they may import their types and receive data and callbacks as props. The lint step enforces this. Components must not reference business lifecycle or resource management. Keep API calls, domain validation, retries, polling, error translation, and business-state transitions out of components.

### Views

- `src/views` holds heavy business UI components: rendering, routing, and event wiring. Views consume readonly view-model state and invoke store actions.
- React hooks such as `useRef`, `useMemo`, `useState`, `useEffect`, and the rest are forbidden in views. The lint step enforces this.
- Business logic stays in the view-model layer. Workflows, asynchronous operations, validation, state transitions, error mapping, and view-domain state are owned by Zustand stores with an explicit business lifecycle, not by views.
- Data flows into views from route loaders, DOM callbacks for user interactions, and DOM attach/detach through the `onAttach(element)` pattern. Network requests are started by store actions that views invoke, not by views directly.
- DOM attach/detach only acquires and releases what belongs to the attached element: listeners, observers, measurements, object URLs, and reads or operations that exist only to present that element. It never starts, stops, or invalidates a business lifetime such as a connection, subscription, selection, submission, or dialog workflow; those start and stop through explicit transitions of the store or workspace that owns them.
- The application renders under React StrictMode, which replays mounts in development. Every attach/detach handler must leave observable behavior unchanged when setup, cleanup, and setup run again.
- Routing remains in views, but route loading and route-level business state belong in view-model stores. Pass navigation as a callback when a completed workflow needs it.

## Testing

- Integration tests enter through navigation or exercise user behavior through mouse and keyboard operations. Direct access to stores in tests is forbidden.
- Integration tests must bootstrap and render the entire application. Rendering individual React components or views in an integration test is forbidden.
- Tests prefer accessible roles, names, labels, and visible text. Use constants from `data-testid.ts` when an element has no stable semantic selector or the ID represents a supported product state. Ad hoc test IDs and selectors coupled to styling or DOM structure are forbidden.
- Use the complete real application, router, Zustand stores, API clients, single Morty Worker, production daemon, transports, and storage. Do not fake the API transport, replace modules, inject stores, or define request mocks inside scenarios.
- The controlled ACP harness boundary and the separate real-Agent compatibility tests are defined in the root `AGENTS.md` (Delivery) and `docs/TESTING.md`.
