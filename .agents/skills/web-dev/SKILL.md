---
name: web-dev
description: Serve the Morty SPA from this checkout with hot reload while the deployed Worker answers its Chat API and event streams, then sign in with a continue link the user provides. Use when a designer wants to iterate on the browser UI against real data, or to diagnose slow or failing proxied API requests and event streams.
---

# Local Web Development Against the Deployed Worker

Serve the browser app from this checkout so edits under `packages/web/src`
hot-reload, while `/morty/api` requests and event streams are answered by the
**deployed Worker**. The designer sees their paired computer,
sessions, and connected Runtime while iterating on markup, styling, and
interaction.

What is local: the SPA modules and their edits, served by Vite. What is
remote: the deployed Worker origin (default `https://morty.build`), which owns
identity, computer access, and Session requests. Nothing here deploys or mutates
the deployed Worker's configuration.

Use `chat-local-full-dev` when the Morty Worker must run locally,
and `agent-verify-user-journey` for a full generation-journey verification. This
skill needs no `.dev.vars`, no local Worker, and no cloud deployment credential.

## Prerequisites

| Requirement | Detail |
| --- | --- |
| Checkout | This repository with `package.json`, `vite.config.ts`, and `vite.web-dev.config.ts` at its root; locked dependencies installed. |
| Toolchain | The Node.js version in `.nvmrc` and pnpm version pinned in `package.json`. |
| Deployed origin | The Worker origin to proxy to. Default `https://morty.build`; when the user names another, set it via `WEB_DEV_ORIGIN`. |
| Continue URL | A `https://<deployed>/continue#code=…` link from the user for sign-in. The code is a one-time secret: never print, log, or commit it. |

Stop and ask if there is no continue link; do not invent credentials or redeem
links from any other source. A link without `harness`/`sessionId` parameters
redeems the identity and lands on the Chat page; one with them also imports that
native session and requires its Runtime to be online.

## Proxy configuration

The SPA sends API requests and event streams to its own origin. The dev-server
proxy forwards `/morty/api` to the deployed Worker and rewrites the `Origin`
header. The repository ships this proxy as
`vite.web-dev.config.ts`, committed next to `vite.config.ts` — use it as-is and
do not write a per-session config under `.wrangler/` or anywhere else.

The committed config defaults to `https://morty.build`. When the user names a
different deployed origin, override it through the environment instead of
editing the file — never substitute an origin the user did not name:

```sh
WEB_DEV_ORIGIN=<deployed-origin> NODE_OPTIONS=--use-env-proxy pnpm exec vite --config vite.web-dev.config.ts
```

Keep the committed proxy configuration: origin rewriting preserves same-origin
request checks, and its HTTP agent honors the environment proxy when Node's
proxy support is enabled. A direct connection may fail on networks that require
an explicit proxy.

## Start the dev server

Run the committed config with Node's environment-proxy support so `globalAgent`
honors `HTTPS_PROXY`/`HTTP_PROXY` when they are set, setting `WEB_DEV_ORIGIN`
only when targeting an origin other than the default:

```sh
NODE_OPTIONS=--use-env-proxy pnpm exec vite --config vite.web-dev.config.ts
```

The committed config asks the OS for a free random port above 10000, so
concurrent web-dev servers never collide. Read the actual port from the start
output's `Local: http://localhost:<port>/` line and use it for every later URL
and check; the port changes on every start.

## Verify the topology before opening the app

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:<port>/
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:<port>/morty/api/v1/health
```

Expect `200` for the SPA and `204` from the proxied deployed Worker. The second
request proves the proxy reaches the deployed origin; if it hangs or errors,
fix the proxy layer before touching the browser.

## Sign in with the continue link

Rewrite the user's continue URL to the local origin, keeping the hash intact,
without printing it. Given `https://morty.build/continue#code=…`, open:

```text
http://localhost:<port>/continue#code=…
```

The Continue page redeems the transfer code through the proxy, stores the
identity, and lands on the Chat page with the user's real sessions. A code is
one-time: if redemption fails, ask the user for a fresh link rather than
retrying the spent one. Open the link in a fresh browser profile or session so
no other stored identity interferes.

## Iterate

Edits under `packages/web/src` hot-reload without losing the session. Capture
representative states under `test-results/` when the user asks for previews.
Only the SPA runs locally: conversations, sessions, and every API write happen
on the deployed origin, so treat generated content and session data as the
user's real data.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Proxied requests are slow or fail | Direct egress to the origin may be slow or reset | Compare the local health endpoint with the deployed one; use Node's environment-proxy support when the network requires it |
| Repeated connection failures during development mounts | Application lifetime may be coupled to React mount cleanup | Keep StrictMode enabled; inspect application ownership and ensure mount replay does not close shared transports |
| `503`/`502` from `/morty/api` through the proxy | Wrong `target` origin, or the deployed Worker is down | Verify the origin with `curl` directly, then check `WEB_DEV_ORIGIN` and the config's `target` |
| Continue page rejects the code | The one-time code was already redeemed, or it expired | Ask the user for a fresh continue link |

## Constraints

- Never deploy, publish, or mutate the deployed Worker from this flow.
- Treat the continue code and the redeemed identity as secrets: never print,
  screenshot, or commit them.
- Do not point the proxy at an origin the user did not name. The default in
  `vite.web-dev.config.ts` is `https://morty.build`; override it only with
  `WEB_DEV_ORIGIN` set to an origin the user named.

## Cleanup

Stop the dev server with Ctrl-C. The committed `vite.web-dev.config.ts` is
shared, so do not edit or delete it during cleanup. Browser evidence under
`test-results/` is retained.
