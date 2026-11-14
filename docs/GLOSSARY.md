---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Morty contributor glossary

Morty owns its browser application, local Runtime and internal cloud services.
This glossary describes their authorization and ownership boundaries. For
user-facing behavior, start with the [usage guide](GUIDE.md).

A computer in the switcher is a machine account this browser remembers. Switching
opens that computer's URL and loads its own access credentials and conversation.
Each computer is an authorization and storage boundary.

## How the main concepts relate

A paired Runtime connects one computer to Morty. It discovers installed Agents and
runs authorized work in local directories. The browser opens conversations owned
by those Agents through that Runtime. Sharing browser access does not transfer
ownership of the Agent's history to Morty.

## Morty application concepts

### Computer

The machine account and isolation boundary for a paired Morty installation.
Runtime pairing, browser access, conversation metadata and sharing are scoped to
this computer. Access to one computer never grants access to another. A computer
identity is not a Native Session identity.

### Owner and browser access

The owner identity controls access to a computer. Browser access is established
through setup handoff or explicit sharing and can be revoked. This identity is
separate from the operating-system account running the daemon and from the Agent's
own account.

### Conversation

The user-facing chat Morty opens in the browser. A conversation presents messages,
tool activity, interactions, files, and controls around a Morty Session.

An established Morty conversation uses the underlying Agent's Native Session ID.
Morty does not assign an independent conversation or Session identity. The native
identity is scoped to the selected Agent and Runtime on an authorized Computer;
the same native value elsewhere does not identify or authorize the same work.

### New Session draft

A New Session draft is a browser-only draft containing the user's selected Agent, workspace,
settings, prompt, and attachments. Opening or abandoning it creates neither an
Agent session nor a managed conversation record.

Sending the first prompt asks the Runtime to create a real session through the
Agent harness and submit that prompt to it. The returned Native Session ID becomes
the conversation's identity. Pending work is tracked as an operation, not as a
provisional Session. Retrying an uncertain first send must not create another
session or submit the same prompt twice. A creation failure preserves the draft;
if creation succeeds but the prompt fails, Morty retains the real conversation
and shows that failure there.

### Managed Session

A Morty Session that the computer's Runtime holds, so it can appear in the
conversation directory and be reopened. The Runtime's record is the only
directory of Managed Sessions; it is discovery metadata and does not mean Morty
stores a complete copy of the Agent's history. The cloud keeps no separate list.

Archiving a Managed Session closes it and removes the Runtime's record, so it
leaves Morty's conversation list. It must not be assumed to delete the Agent's
Native Session or local history; importing that Native Session brings it back.

### Machine

The computer, VM, container, or WSL environment where the daemon and Agents run.
Setup saves the Computer's identity and pairing in Morty's local state directory;
there is no separate Machine identity. The Runtime executes on this Machine,
while the cloud Relay authenticates and routes its connection. Replacing a Computer
or pairing does not replace the physical Machine.

### Local daemon

The Morty service running on the Machine. It maintains the Runtime connection,
discovers Agents, starts or restores Agent work, and enforces the local filesystem
and execution boundary. Morty's Worker and browser do not execute the coding Agent.

### Runtime

The Computer-scoped Morty execution endpoint created by pairing the local daemon.
Morty routes Agent discovery, workspace browsing, Session operations, and live
events through it. One Runtime connection carries many Sessions; a Runtime is not
created per conversation.

### Agent

A coding Agent available through the Runtime, such as Codex, Claude Code, or Pi.
The selected Agent determines which native-history, fork, interaction, and content
capabilities exist. Morty must not present a capability merely because another
Agent supports it.

### Workspace and directory

The local filesystem context authorized for Agent work. Clients select explicit
directory paths, not opaque directory identities. The local execution boundary
validates the requested paths, resolves their filesystem targets, and authorizes
the resolved directories before use. Relative paths resolve against the paired
Computer's configured workspace; home-relative paths select the current local
user's home. Discovery and previously accepted paths never replace current local
authorization.

## Session and history concepts

### Morty Session

The live conversation and execution scope hosted by one Runtime. It selects an
Agent and workspace context, receives turns and control operations, and publishes
events to Morty. This is the Session Morty's browser connects to and the Session
stored in the managed conversation directory.

The first send from a New Session draft creates a real Agent session before submitting
the prompt. Morty uses the returned Native Session ID for the resulting execution
scope and managed conversation. Opening existing Agent history uses its existing
native identity rather than allocating a Morty-specific one.

### Native Session

A conversation record owned and persisted by the underlying Agent. Examples include
a Codex thread or a Claude Code conversation saved on the Machine. It can exist
before Morty is installed and can remain after Morty stops.

Native Sessions are discovered through the selected Agent's capabilities. Their
availability, identity, history completeness, and ability to resume or fork remain
authoritative at the Agent boundary.

### Native Session entry

A discovery result describing one Agent-owned conversation in a particular
workspace, identified by its harness and harness-owned Session ID. Discovery is
not an authorization grant: opening or forking a conversation resolves its current
metadata and authorizes its directories locally, without requiring an earlier
listing or a process-local discovery handle. Pairing authorizes the Computer;
requests do not carry an additional workspace binding identity.

### Open / import

Continue the selected Native Session through Morty without intentionally cloning
its history. The Runtime asks the Agent adapter to load or resume that native
conversation and exposes the resulting live work through a Morty Session.

The code and protocol use `import` for this operation while the UI says **Open**.
Import here means “attach this Agent-owned conversation to Morty's managed flow,”
not “upload and permanently copy its entire history into Morty.” Once opened, the
resident Agent state is authoritative for that Morty Session; alternating writers
between Morty and the native client can diverge or be refused.

### Fork

Create an independent continuation from a selected Native Session when the Agent
supports native forking. The Agent harness creates the fork and returns its new
Native Session ID; Morty does not preassign a destination Session identity. The fork
preserves the source context available to the Agent. Further messages in the fork
must not be assumed to update the source Native Session. An uncertain fork outcome
must not automatically start another fork.

Fork is a capability, not a fallback implementation for import. If the Agent cannot
fork reliably, Morty must report that limitation rather than simulate success.

### Session identity

The harness-owned **Session ID**, together with the harness on the selected
Computer, identifies the conversation for discovery and subsequent operations.
Morty does not assign an additional Session entry identity or conversation ID.

Native identity must be scoped by Computer, Runtime, and Agent. A native identity
does not replace validation and authorization at the local execution boundary.
Request and operation identities track pending work and recovery, not separate
conversations.

### History

Morty presents history from the live Session and the Agent's Native Session. These
sources have different ownership and recovery guarantees. Morty keeps no cloud copy
of history, so a managed record in the sidebar is not proof that full history is
available while the Machine is offline.

### Turn, queue, and interaction

A Turn is a unit of user input submitted to a Morty Session. Morty can queue a
follow-up while another Turn is active. An interaction is a decision requested by
the Agent during execution, such as a permission or elicitation request; it is not a
new conversation or Session.

## Access and connection concepts

### Setup and pairing

Setup creates or reuses Morty's local identity and establishes the Morty pairing
needed for a Runtime. Pairing authorizes a local daemon for a Computer and stores its
Runtime connection locally. Reconnecting an existing Runtime is not a new pairing.

### Sharing link and browser identity

A Morty link carries the information needed to establish an authorized browser
identity for a Computer or conversation flow. It is not the daemon's Runtime
credential. Revoking shared access must not be modeled as deleting the Machine's
Agent history.

### Session access

The short-lived credential and endpoint information that let a browser connect to
one Morty Session. Session access does not make the browser a Runtime and does not
grant access to every Session on the Machine.

### Relay

The trusted Morty cloud service that authenticates and routes traffic between
Morty and the local Runtime. It carries live traffic but does not turn Morty's
managed metadata into a complete cloud copy of Native Session history.
