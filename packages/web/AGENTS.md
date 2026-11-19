---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Web Architecture Rules

These rules apply to `packages/web`, in addition to the root [AGENTS.md](../../AGENTS.md).

React only renders. `src/view-models` owns business workflows, asynchronous operations, validation, state transitions,
derived business data, view-domain state, and user-facing failure mapping. Views and components show that state and
hand user actions to store actions; they hold none of it.

## View models

- Use Zustand stores in the view-model layer. Prefer vanilla `createStore` factories for screen- or resource-scoped state and the existing Zustand `create` API for intentionally shared application state.
- Do not implement view-models as custom React hooks. Views create or receive a store and subscribe with Zustand's `useStore`.
- Do not call `store.subscribe(...)`: it creates an implicit business lifecycle outside the store's explicit transitions. State transitions go through explicit store actions that announce outcomes through port callbacks; React reads state with `useStore` or a `useSyncExternalStore` port.
- Store factories are pure construction. Do not create effects, such as subscriptions, listeners, timers, requests, or other side effects, while creating a store: they create an implicit business lifecycle outside the store's explicit transitions. Effects start from explicit lifecycle actions and stop explicitly.
- A store action that performs external work does not publish state after it is cancelled.
- Inject external ports or construct production clients inside store factories.

## Components

- `src/components` holds UI that renders what it receives.
- React hooks are allowed in components so developers can implement complex animation, visual effects, and better UI/UX. Components may own ephemeral DOM-only state such as focus targets, element measurements, disclosure/popover visibility, and uncontrolled input refs.
- Effects in components may bind and release browser or DOM resources such as listeners, timers, observers, and object URLs, and may drive visual state. Any effect outside that scope requires an explicit recorded rationale in the component.
- Components must not import `src/views`, `src/view-models`, or `src/services` at runtime; they may import their types and receive data and callbacks as props. The lint step enforces this.
- Tooltips for vertically stacked options open beside the hovered or focused option: to the right by default, then to the left when the right side lacks space. A tooltip repeating an option label appears only when that label is clipped.

## Views

- `src/views` holds business UI: rendering, routing, and event wiring.
- React hooks such as `useRef`, `useMemo`, `useState`, `useEffect`, and the rest are forbidden in views. The lint step enforces this.
- Data flows into views from route loaders, DOM callbacks for user interactions, and DOM attach/detach through the `onAttach(element)` pattern.
- DOM attach/detach only acquires and releases what belongs to the attached element: listeners, observers, measurements, object URLs, and reads or operations that exist only to present that element. It never starts, stops, or invalidates a business lifetime such as a connection, subscription, selection, submission, or dialog workflow; those start and stop through explicit transitions of the store or workspace that owns them.
- The application renders under React StrictMode, which replays mounts in development. Every attach/detach handler must leave observable behavior unchanged when setup, cleanup, and setup run again.
- Routing remains in views, but route loading and route-level business state belong in view-model stores. Pass navigation as a callback when a completed workflow needs it.
