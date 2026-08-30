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

/**
 * The request path, for a request that may carry no `Host` header or a
 * malformed one. Never throws.
 *
 * Two distinct states, and the second was missed by the fix for the first:
 *  - NO Host — Bun sets `req.url` to the bare path ("/api/live"), which is not
 *    an absolute URL, so a one-argument `new URL` throws.
 *  - MALFORMED Host — Bun composes `http://<host><path>`, so the BASE IS NEVER
 *    CONSULTED and `new URL(req.url, base)` throws anyway. Measured:
 *    `Host: a b c` and `Host: [::zz` both produced
 *    `TypeError: "http://a b c/api/live" cannot be parsed as a URL`.
 *
 * Both end the same way if they escape: /api/live 500s on a healthy pod, and
 * /chat/ws answers a large HTML body instead of the 426 — which is the failure
 * signature the runbook tells the operator to read as "something in the path
 * answered the upgrade as an ordinary request". A stub that emits the signature
 * it exists to detect is the hello-world mistake with extra steps.
 */
function requestPath(rawUrl: string): string {
  try {
    return new URL(rawUrl, "http://localhost").pathname;
  } catch {
    // Fall back to the raw request target: drop a `scheme://authority` prefix
    // if one is present, then the query and fragment.
    const afterAuthority = rawUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, "");
    const path = afterAuthority.split("?")[0].split("#")[0];
    return path.startsWith("/") ? path : `/${path}`;
  }
}

// The upgrade is accepted on ANY path. muninn's real socket is /chat/ws, and
// the point of step zero is the ingress + sidecar leg, not the routing — but
// checking it on /chat/ws specifically is free and is what the runbook says to
// do, so nothing here narrows it.
Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // a container-local bind is unreachable to the kubelet
  // Bun's DEFAULT error page renders the throwing source file and its absolute
  // filesystem path — measured at ~67 KB for the malformed-Host throw above,
  // inside a base64 `binary/peechy` payload, which is why a plaintext grep of
  // the body finds nothing and the first check for this said it was clean.
  //
  // This handler replaces that page for every throw the `fetch` handler
  // returns from — `requestPath` closes the two states we found, this closes
  // the ones we did not. Scoped deliberately: an earlier version claimed
  // "EVERY throw", and a throw from `websocket.open` or `websocket.message`
  // propagates out of `server.upgrade()` and KILLS THE PROCESS instead.
  // Measured. Neither handler below can throw as written — keep it that way.
  error(err) {
    console.error("step-zero echo stub: unhandled error", err);
    return new Response("step-zero echo stub: internal error\n", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
  fetch(req, server) {
    const path = requestPath(req.url);

    // In autoLoginIgnorePaths, so this is reached with NO credential — which
    // is what the kubelet needs. Keep it trivial: a probe that touches
    // anything is a probe that can fail for a reason unrelated to the probe.
    if (path === "/api/live") return new Response("ok");

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
    // No `websocket.idleTimeout` override. THREE earlier comments here
    // explained that choice and all three were wrong, the last of them while
    // correcting the other two. Only measurements now, taken on the wire by
    // decoding opcode 9 with a client that never pongs:
    //
    //   this stub, as shipped          first PING t=104.0s, closed t=120.0s
    //   + `websocket.idleTimeout: 255` no PING, no close — open past t=150s
    //
    // What follows from that, and nothing beyond it:
    //  - The first keepalive is at ~104 s, so across the runbook's ~60 s window
    //    the connection is GENUINELY idle, zero frames in either direction. A
    //    socket that dies at 60 s is the INGRESS. One earlier comment claimed
    //    the opposite, twice.
    //  - ~104 s is not `idleTimeout/2` in any reading. Do not reintroduce that
    //    formula.
    //  - `websocket.idleTimeout` DOES govern this, as the second row shows. The
    //    SERVER-level `idleTimeout` does not, and conflating the two is what
    //    made the previous comment wrong: muninn sets `idleTimeout: 255` at the
    //    server level (src/index.ts:262, re-verified at ref fb5e6b5d, for SSE)
    //    and sets no
    //    `websocket.idleTimeout` at all. So this stub and muninn's socket run
    //    the SAME default, parity holds, and the round-8 comment that said so
    //    was right — it was the round-9 "correction" that was wrong.
    //  - The day muninn sets `websocket.idleTimeout`, that parity breaks and
    //    nothing in this repo will notice.
    //
    // See docs/step-zero-websocket.md, which carries the same measurements.
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
