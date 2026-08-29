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
    const url = new URL(req.url);

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
      { status: 426, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
  websocket: {
    // No `idleTimeout` override: Bun's own default would otherwise mask the
    // property under test. If the socket dies at ~60 s we need that to be the
    // INGRESS closing it, not this server.
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
