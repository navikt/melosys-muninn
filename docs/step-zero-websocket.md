# Step zero: prove the WebSocket through the ingress

A chat-only muninn has exactly one channel for a turn: `/chat/ws`. Everything
else on the page is a fetch that could, at a pinch, be worked around. The socket
cannot. So this is the first thing to prove and the reason to prove it before
buying anything expensive.

## What is already known

`scripts/wonderwall-ws-harness.sh` in the muninn repo established two facts
locally, and they are load-bearing:

- a WebSocket upgrade through wonderwall **does** arrive at the app carrying
  `Authorization: Bearer …`, and
- wonderwall's session cookie is sent `SameSite=Lax`.

That matters because **muninn mints no session cookie in `entra` mode** —
`writeSessionCookie` returns early when there is no local config. The socket is
authenticated from the Bearer channel or not at all.

## What is not known

The ingress. wonderwall proxying an upgrade on a developer's machine is not the
same as an nginx ingress controller doing it in dev-gcp, and this is the half
that has surprised people before.

## The catch

Step zero is first but it is **not free**. Proving the upgrade *through the
sidecar* requires §1–§4 of `PREREQUISITES.md` already in place — the app
registration, admin consent, the group and **both** ingresses — because `autoLogin`
refuses an unauthenticated upgrade **at the sidecar**, and it never reaches the
app at all. The harness measured exactly that locally.

So the sequence is:

1. Buy §1–§4 (app registration + consent + group + the two ingresses).
2. Deploy something — a stub, or this image with a database that is not yet
   provisioned, which crash-loops on purpose but still serves nothing.
3. Only then can the upgrade be attempted end to end.

There is no shortcut that proves the sidecar half without the login half.

## How to check it

Open the ingress in a browser, complete the wonderwall login, land on `/chat`,
and watch the network panel for the `/chat/ws` upgrade. What you are looking for,
in order:

- **101 Switching Protocols.** A 401 means the token did not arrive; a 200 with
  an HTML body means something in the path answered the upgrade as an ordinary
  request.
- **The socket stays open past ~60s.** An ingress that closes idle upgrades
  turns every long turn into a dropped answer. muninn's client retries in ~2 s,
  but the turn in flight does not come back.
- **A turn completes over it** — send a message and get a streamed reply, not
  just a connected socket.

## The three ways this fails that are not the ingress

Worth ruling out before blaming the proxy:

1. **`MUNINN_ALLOWED_ORIGINS`.** The upgrade is origin-checked against the same
   configured list as every write, using the same code (`decideOrigin` — there
   is deliberately no second origin check in the WS path). If the origin of the
   page you are on is not listed verbatim with its scheme, the handshake is
   refused and the page otherwise looks fine. There are **two** origins here —
   `intern` and `ansatt` — derived from the pair of ingress variables, so test
   the socket from **both** domains. A single-origin list is a page that works
   for whoever has naisdevice and fails silently for everyone else.
2. **`Recreate` + one replica.** Every rollout drops every socket, by design.
   A reconnect right after a deploy is not a bug.
3. **The bot.** A socket that connects and then answers nothing is the model
   credential (`PREREQUISITES.md` §7), not the transport. `/api/live` answering
   200 tells you nothing about whether a turn can complete.
