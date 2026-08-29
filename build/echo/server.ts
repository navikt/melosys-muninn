/**
 * Step zero's WebSocket echo server — see docs/step-zero-websocket.md.
 *
 * The single question it exists to answer: does a WebSocket upgrade survive
 * the dev-gcp ingress controller and the wonderwall sidecar? Nothing else.
 * It holds no state, reaches no database, calls no model, and is thrown away
 * the moment the first real deploy replaces it.
 *
 * WHY AN ECHO SERVER AND NOT A HELLO-WORLD. A plain HTTP server answers an
 * upgrade request as an ORDINARY REQUEST — 200 with a body — which is one of
 * the two failure signatures step zero is looking for. A hello-world stub
 * therefore reports the exact failure it is meant to detect, and reports it
 * identically whether the ingress is fine or broken. This one upgrades or it
 * does not, and the browser's network panel says which.
 *
 * WHY IT ECHOES RATHER THAN JUST UPGRADING. A 101 proves the handshake
 * crossed. It does NOT prove the connection carries frames afterwards, and an
 * ingress that terminates an idle upgrade is the second failure mode named in
 * the runbook. Echoing lets the operator send a frame at t=0 and another past
 * the ~60 s idle window and see both come back.
 */

const PORT = Number(process.env.PORT ?? 3000);

// The upgrade is accepted on ANY path. muninn's real socket is /chat/ws, and
// the point of step zero is the ingress + sidecar leg, not the routing — but
// checking it on /chat/ws specifically is free and is what the runbook says to
// do, so nothing here narrows it.
Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // a container-local bind is unreachable to the kubelet
  fetch(req, server) {
    // The base is not optional. With no Host header — an HTTP/1.0 probe, an L4
    // checker, an ingress default-backend probe, `curl --http1.0` — Bun sets
    // `req.url` to the BARE PATH ("/api/live"), which is not an absolute URL,
    // and a one-argument `new URL` throws. Measured over a raw socket: every
    // path answered 500, including /api/live (a liveness failure on a healthy
    // pod) and including /chat/ws, where it replaced the 426 body that is this
    // file's entire reason to exist with an unexplained 500.
    const url = new URL(req.url, "http://localhost");

    // In autoLoginIgnorePaths, so this is reached with NO credential — which
    // is what the kubelet needs. Keep it trivial: a probe that touches
    // anything is a probe that can fail for a reason unrelated to the probe.
    if (url.pathname === "/api/live") return new Response("ok");

    if (server.upgrade(req)) return undefined; // 101; Bun writes the response

    // Reached when the request was NOT an upgrade. Say so explicitly rather
    // than serving a page: an operator who sees this body in the network panel
    // where they expected 101 is looking at the failure signature itself, and
    // the text names it.
    return new Response(
      "step-zero echo stub: this was not a WebSocket upgrade request.\n" +
        "If you see this body where you expected 101 Switching Protocols,\n" +
        "something in the path answered the upgrade as an ordinary request.\n",
      {
        status: 426,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          // RFC 7231 §6.5.15 requires these on a 426, and a client that treats
          // the status as "renegotiate" has nothing to read without them.
          upgrade: "websocket",
          connection: "Upgrade",
        },
      },
    );
  },
  websocket: {
    // No `idleTimeout` override, and know what that does and does not buy.
    // Omitting it does NOT leave the socket untimed: Bun's default is 120 s
    // either way. What it buys is PARITY — real muninn is also `Bun.serve`
    // with this same default, so whatever the ingress does to this socket it
    // will do to that one.
    //
    // It also means the runbook's "survives past ~60 s" check is not a test of
    // an idle connection and cannot be: uWS auto-pings at ~idleTimeout/2, the
    // browser auto-pongs, and that traffic resets nginx's `proxy_read_timeout`.
    // Measured: 180 s with no application frames and the socket still open.
    // Disabling keepalives to make it a true idle test would test something
    // the real app never does. See docs/step-zero-websocket.md.
    open(ws) {
      ws.send(`echo stub open at ${new Date().toISOString()}`);
    },
    message(ws, message) {
      ws.send(message); // the whole contract
    },
  },
});

// Goes to the pod log, so `kubectl logs` distinguishes "the stub is up" from
// "the ingress never reached it" without a browser.
console.log(`step-zero echo stub listening on 0.0.0.0:${PORT}`);
