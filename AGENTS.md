---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Engineering Rules

These rules apply to the entire repository. You must read [CONTRIBUTING.md](./docs/CONTRIBUTING.md) before opening an issue or pull request; it defines the contribution process. See [TESTING.md](./docs/TESTING.md) for test commands and release acceptance. Every code review must also follow [CODE_REVIEW.md](./docs/CODE_REVIEW.md).

## Design priorities

State and interfaces are the costly part of a design. Stateless code can be
rewritten at any time; stored data has to be migrated, and the callers of an
interface do not upgrade themselves. Modules that could change independently
become coupled once their state is merged. Tests show that today's coordination
works; they do not show whether a piece of state should exist or how often it will
force costly changes.

When writing or changing code, settle these first, in this order:

1. [State](#state): cut state, and split it.
2. [Computation](#computation): keep business rules pure.
3. [Interfaces](#interfaces): keep operations narrow, with a real
   [compatibility](#compatibility-is-mandatory-by-default) plan.

## Repository setup

- Use the pinned Node and pnpm versions and install the locked workspace dependencies before building or testing. Morty owns its Runtime and cloud sources in one workspace.

## Trust Boundary

The local execution boundary is the only authority allowed to approve local side effects.

- Treat every value received from a remote client, transport, agent harness, model, configuration file, or persisted session as untrusted input.
- Process untrusted input in this order: decode as `unknown`, validate its schema, normalize and resolve security-sensitive targets, authorize the requested capability and resolved target, execute, then record an audit event.
- Validate both the requested representation and the resolved representation of paths, URLs, commands, and other security-sensitive targets.
- Never let a remote assertion, prior validation result, or user-interface approval bypass authorization at the execution boundary.

## Independent product

Morty is one product. Relay is an internal responsibility of the Morty Worker,
not a public developer platform or a separately deployed service. Conversation
history belongs to the connected Computer and Agent storage; Morty keeps no cloud
copy. Production and isolated local development are the supported environments.
Device access, recovery, pairing and service authorization remain enforced at
their owning boundaries. Removing an authentication surface never authorizes
anonymous access to privileged operations.

Production uses Morty-owned resources and credentials. Local development must
work without production secrets or remote test environments.

Preserve production business records and Agent-owned history. Publish only the
exact archive that passed the complete acceptance gates in `docs/TESTING.md`;
activate matching cloud and CLI artifacts and record their source revision and
recovery procedure.

## State

State means anything a later step reads back: database rows and columns, Durable
Object and local storage, browser storage, store fields, caches, and long-lived
object fields.

### Store only what cannot be computed

- Before adding a stored value, show that it cannot be computed from state that
  already exists. That a value is displayed does not mean it must be stored.
- Do not keep a count beside its list, a copy of the selected object beside its
  identifier, or a flag that mirrors other fields. Every extra copy is something
  every later change must remember to keep in sync.
- Do not add effects, subscriptions, or callbacks whose only purpose is to keep two
  values consistent; compute one from the other.
- Store historical facts. A value that must not change when its source changes
  later, such as the price at which an order was placed, is a fact of its moment.
  Ask: if the source changes tomorrow, should this value change? If yes, compute
  it; if no, store it.
- Delete state that no active product path reads or writes: tables, columns, and
  their data, and the migrations of a database the product no longer binds.

### Split state; when unsure, split

- Give each independent process its own record and its own transitions. Processes
  that can advance at the same time, such as a merchant preparing an order while
  a courier travels to it, must not share one status.
- Quotes, delivery, refunds, and compensation each get their own records instead
  of accumulating columns on one central record. Many nullable or defaulted
  columns, or a column that depends on another non-key column, are signs of merged
  state.
- When unsure, split. Joining split state for a read is cheap; separating merged
  state later costs a migration and untangling every writer.
- A view may aggregate several records for display. That never justifies one
  mutable aggregate that every module can change.

### One owner for each record and each rule

- Each record, table, and store has one owning module that changes it. Other
  modules call the owner instead of writing its state. Separate tables that every
  module may still write are not a split.
- Each business rule is decided in one place, from its first use. Every caller,
  whether a view, a service, the Runtime, or the Worker, asks that owner instead of
  re-deciding the rule, so changing the rule takes one edit.

### Persisted schemas are normalized

- Keep persisted schemas in normal form. Denormalize, cache, or copy data only
  with a benchmark under real load that shows a user-visible cost, and name the
  authoritative source and the single writer of the copy. Removing the copy must
  leave every result correct, only slower.

### Make illegal states unrepresentable

- Represent protocol and lifecycle states with discriminated unions, not combinations of optional fields or booleans.
- Give each variant exactly the data that is valid in that state, using `readonly` properties for state values.
- Handle state variants exhaustively so a new variant causes a compile-time failure at every incomplete decision point.
- Express state changes through explicit transition functions. Do not mutate fields into a different state.
- Do not use type assertions, `Partial`, or non-null assertions to bypass state invariants.

## Computation

- Write business rules as functions that take exactly the inputs they need and
  return a result. Reading state, performing I/O, and saving results belong to the
  caller.
- A computation must not read or write a whole store or other shared mutable
  state. Its result is determined by its inputs and its rule alone, never by
  whether a component mounted, which effect ran first, or whether a request already
  returned and updated a store.
- Moving code out of a React component does not make it pure: a function that
  still reads or writes the whole store depends on what other code did before it.

## Interfaces

### Operations

- Expose operations with business meaning, such as requesting a refund or
  confirming a shipment. Do not expose generic mutations such as
  `updateStatus(newStatus)` that leave the caller to decide when a change is valid
  and what it should become.
- Reuse one operation for one business action across callers instead of building
  one per page. An interface is small when its callers need to know little, not
  when its implementation is short.
- Enforce an invariant that one operation must guarantee inside that operation,
  atomically, on the side that owns the state. Keeping exactly one default
  address, for example, is the server's job, not a sequence of client writes that a
  failure can leave half done.
- State each operation's preconditions, what success means, whether a failure may
  already have written, and how retries and concurrent changes behave, and make the
  implementation guarantee them. A disabled control does not replace server-side
  protection against duplicate execution.

### Types

- Use `readonly` properties for protocol messages, domain values, and port interfaces.
- Declare callbacks and port operations as function properties, such as `readonly send: (message: Message) => Promise<void>`, so `strictFunctionTypes` checks their parameter variance.

## Compatibility is mandatory by default

Morty Web, the client package, deployed services, local Morty Runtimes, and stored data
upgrade independently. Preserve existing external contracts and behavior in both
directions: new clients with old servers/Runtimes, and old clients with new
servers/Runtimes, including already-open browser pages and stored messages.
Releasing everything together does not update every deployed peer, and a
successful all-new deployment does not establish compatibility.

- Only an explicit instruction from the human user or maintainer to make a
  particular breaking change authorizes incompatibility. A request to refactor,
  simplify, upgrade, bump a major version, or remove apparently unused code does
  not authorize it, nor does an AI-authored assertion or an assumption that users
  will upgrade. Ending support for a released peer is itself a breaking change that
  needs such an instruction; AI agents must not invent one.
- When a breaking change is explicitly required, limit it to the authorized
  contract and record the instruction, affected peers/data, rollout, and recovery
  consequences in the PR. Preserve every unaffected contract and do not infer
  permission to break adjacent ones. Do not request the same authorization again
  when it is already explicit. An authorized contract change never authorizes
  deleting Agent-owned data.
- Preserve accepted request formats, response meanings, defaults, validation,
  error codes, authorization, bounds, operation identity, and retry, idempotency,
  and ambiguous-failure recovery guarantees. Removed, renamed, or newly required
  fields break existing peers. New fields, enum values, or message kinds are not
  automatically compatible: check the actual released readers and callers. A
  decoder that succeeds while dropping part of the request, such as an
  attachment, is not compatible. Silently ignoring an unknown operation is not
  successful execution.
- Enable a new operation or representation only after establishing support for
  that contract at the relevant protocol boundary. Define the behavior of peers
  that omit the new capability; they must retain the existing supported behavior.
  Agent/ACP capabilities do not establish Runtime/relay protocol support.
  Timeouts, ignored unknown messages, and application release-number branches are
  not protocol negotiation.
- Deploy compatible receivers before enabling new senders. Keep the old path
  usable during independent upgrades and supported rollback. Do not require a
  browser refresh, Runtime upgrade, or synchronized deployment to preserve an
  existing supported operation.
- The owning protocol adapter makes compatibility decisions; views and callers do
  not.
- Do not switch protocol representations or generate a new operation identity
  after an ambiguous failure to guess whether a peer supports an operation.
  Preserve the request's meaning, identity, and existing recovery guarantees.
- For a changed contract, provide focused integration/contract evidence for both
  mixed-version directions using released peers or independently retained old
  contracts; exercising the new implementation twice is not such evidence. Assert
  the user-visible result and the relevant payload, not only that a connection
  stays open or a request succeeds. Cover failure and retry cases when the change
  affects those guarantees. Do not replace the old baseline with the new
  implementation or weaken validation, authorization, or size limits to make
  compatibility pass.

## Async Operations

- Every asynchronous operation that waits on an external system must accept cancellation. Finite operations need a timeout; long-lived streams need connection and liveness deadlines.
- Propagate cancellation through every layer. Do not catch, translate, or retry cancellation as an ordinary failure.
- Make resource ownership explicit. The code that acquires a connection, stream, process, lock, timer, or concurrency slot must release it on success, failure, and cancellation.
- Keep retries bounded, cancellable, and limited to operations that are safe to repeat.

## Errors

- Failures that cross a subsystem, port, or protocol boundary must use a typed error contract with a stable machine-readable code.
- Branch on error codes or types, never on human-readable message text.
- Preserve the original cause when translating an error, and expose only sanitized messages across trust boundaries.
- Keep cancellation, timeout, retryable, and terminal failures distinct.

## Code comments

These rules apply to all contributors, including AI agents, in source code,
tests, scripts, and configuration files.

- Default to adding no comments. Use clear names, types, and code structure.
- Do not add comments explaining **what** the code does or **how** it works.
  This includes JSDoc that restates declarations, field descriptions, procedural
  narration, and decorative section labels.
- Add a comment only when it is necessary to explain **why**: a
  non-obvious constraint, decision, or tradeoff that the code cannot express.
  Keep it short and specific. If clearer code would make it unnecessary, improve
  the code instead.
- Preserve legally required license and attribution notices and functional
  compiler, lint, and test directives. Keep any accompanying explanation limited
  to the necessary rationale.

## Documentation changes

- Every Markdown file except `SKILL.md` must include `metadata.change-policy` in its
  YAML frontmatter, stating that changes require a separate documentation-only PR
  for review and approval. Skill entrypoints retain their existing frontmatter.
- Change Markdown files in documentation-only pull requests, separate from code,
  configuration, dependencies, and submodule updates. This includes additions,
  deletions, and renames of `.md`, `.markdown`, and `.mdx` files.
- Review by `taowen-paraflow` is recommended for Markdown changes, not required.
- Documentation defines product intent, constraints, and operational guidance.
  Do not maintain implementation maps, source-file inventories, or copies of
  protocol fields and state machines in Markdown. Make source organization,
  names, and types explain the implementation; comments must follow
  [Code comments](#code-comments).
- When changing an existing documented constraint, propose that change separately
  before implementing behavior that depends on it.

## Delivery

- Deliver behavior as the smallest user-runnable vertical slice through input, logic, and observable output.
- Describe each behavior slice as: "After this, a user can ... and see ..." If that sentence is not concrete, narrow the slice.
- Start every behavior change with a failing Given-When-Then acceptance scenario that proves the user-visible slice through the first supported product boundary that can observe it. Treat the scenario as executable product documentation, and implement only what it requires.
- Do not add unit tests by default. Add one only when the user explicitly requests unit-level coverage or a repository maintainer documents an exception for an invariant that cannot be exercised through a supported product boundary.
- Only write end-to-end tests for happy paths, such as the conversation and setup journeys. Business logic must be covered by integration tests, while protocols and external boundaries use integration or contract tests. Do not test CI, linting, Git hooks, build tooling, dependency configuration, or other repository scaffolding.
- Web application integration tests run in happy-dom, bootstrap and render the complete application, enter through navigation, and exercise user behavior with mouse and keyboard on visible controls. They never render isolated components or views and never access stores. Prefer accessible roles, names, labels, and visible text; use shared `data-testid.ts` constants only when an element has no stable semantic selector or the ID represents a supported product state. Ad hoc test IDs and selectors tied to styling or DOM structure are forbidden. Worker integration tests enter through their production HTTP, WebSocket, Durable Object, queue, or storage boundary.
- Morty Web, Worker, and browser tests keep the single Worker, internal clients, product services, transports, storage, and the production daemon real, reaching the daemon through the real Morty WebSocket endpoint. They inject a stateful controlled ACP harness only through the daemon's Agent dependency argument, and each fixture owns pairing and cleanup of the resources it creates. Separate agent-daemon compatibility tests use the real daemon, each real Agent executable, and its production adapter; a fake LLM provider can replace the model service. A controlled ACP harness exercises production daemon behavior but cannot establish Agent compatibility, whatever Agent label it carries.
- Except for deterministic fake timers, mocks, spies, stubs, monkey patching, module replacement, and canned request interceptors are prohibited. If a real external dependency cannot be used safely or deterministically, inject a stateful fake through its production port.
- Tests involving time must use fake timers with an explicit system time. Every test is prohibited from using real sleeps, wall-clock time, polling delays, or timing tolerances.
- Assert externally observable results, not private control flow, collaborator calls, or implementation details.
- Documentation-only and mechanical refactoring changes do not require new tests when behavior is unchanged.

## Abstraction

### Server layers

Server behavior flows inward through `http/do -> service -> storage -> database`. HTTP routes and Durable Objects translate and orchestrate requests, services own domain validation and transformations, storage owns persistence through the authoritative Drizzle schema and ORM query builder, and gateways communicate our services with external services. Do not skip layers or move domain/protocol decisions into storage. Do not issue raw SQL strings where the ORM can express the query.

- Prefer direct, local, linear code.
- Add a generic code abstraction only for a real external boundary, a second real use case, or proven duplication.
- Do not add speculative extension points, generic frameworks, or unused layers.

## Database schema

- Do not define foreign-key constraints. Enforce relationships and deletion behavior explicitly in application logic.
- Keep the authoritative Drizzle schema for each SQLite target in its own `schema/<target>` directory (for example, `schema/computer-relay-do`). Never place one target's tables in another target's schema, and never use one target's schema as the implicit schema for another target.
- Keep Drizzle configuration in the repository-level `drizzle/` directory and generate each target's migrations into `migrations/<target>`.
- Generate schema migrations with the repository's pinned Drizzle CLI. Never create or edit migration SQL manually.
- Durable Object runtime code must execute committed `.sql` migrations generated for its target; do not embed application-table DDL or migration SQL in TypeScript. Prefer importing the SQL directly with `?raw`. Where the build pipeline cannot import SQL, use a committed code-generation script that copies the generated SQL verbatim into a gitignored module and keep `.sql` as the source of truth.
- Treat the committed migrations of every database the product still binds as immutable history; make subsequent schema changes with a new generated migration.

## Verification

For routine local development, run `pnpm lint`, `pnpm typecheck`, and only the
related test cases. `pnpm ci:check` reproduces the combined static validation and
client tests; run it locally only when diagnosing CI.
