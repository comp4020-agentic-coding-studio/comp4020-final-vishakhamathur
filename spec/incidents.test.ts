import { expect, inject, it } from "vitest";
import WebSocket from "ws";

const baseUrl = inject("baseUrl");
const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";

async function analystCookie(): Promise<string> {
  const res = await fetch(new URL("/", baseUrl));
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

// The server can send `hello` the instant the handshake completes, which
// races a listener attached only after `open` resolves — so every inbound
// message is buffered from socket creation, and waitFor replays the backlog
// before listening live, instead of attaching a listener that can miss a
// message sent before it existed.
const backlogs = new WeakMap<WebSocket, any[]>();

function connect(cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie } });
    const backlog: any[] = [];
    backlogs.set(ws, backlog);
    ws.on("message", (raw: Buffer) => backlog.push(JSON.parse(raw.toString())));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitFor(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 10_000): Promise<any> {
  const backlog = backlogs.get(ws)!;
  const fromBacklog = backlog.findIndex(predicate);
  if (fromBacklog !== -1) return Promise.resolve(backlog.splice(fromBacklog, 1)[0]);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
    const check = () => {
      const idx = backlog.findIndex(predicate);
      if (idx !== -1) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(backlog.splice(idx, 1)[0]);
      }
    };
    const poll = setInterval(check, 20);
  });
}

// Starting a shift and voting both require real, server-tracked state — a
// quorum of currently-connected sessions to start, and a single open vote
// row per (incident, session) to vote. This drives all three through real
// WebSocket connections rather than asserting on internals.
//
// There's exactly one round in memory at a time (by design — see
// PROCESS.md), so this only runs against a freshly-started app still in the
// lobby phase: the state CI always finds it in (a throwaway container per
// run), and the state a local run finds it in right after starting it. If
// someone's been manually playing a round locally and re-runs `pnpm check`
// without restarting the app, there's no round left to drive through this
// path — skip rather than fail on state this test didn't create.
it("starts a shift once three sessions connect, and rejects a duplicate vote on the active threat", { timeout: 15_000 }, async (ctx) => {
  const cookie = await analystCookie();
  const stateRes = await fetch(new URL("/api/game/state", baseUrl), { headers: { cookie } });
  const currentState = (await stateRes.json()) as { phase: string };
  if (currentState.phase !== "lobby") {
    ctx.skip();
    return;
  }

  const [cookieA, cookieB, cookieC] = await Promise.all([analystCookie(), analystCookie(), analystCookie()]);
  const [wsA, wsB, wsC] = await Promise.all([connect(cookieA), connect(cookieB), connect(cookieC)]);

  try {
    await Promise.all([waitFor(wsA, (m) => m.type === "hello"), waitFor(wsB, (m) => m.type === "hello"), waitFor(wsC, (m) => m.type === "hello")]);

    wsA.send(JSON.stringify({ type: "game:start" }));

    const threatMsg = await waitFor(wsA, (m) => m.type === "threat:new");
    const incidentId = threatMsg.incident.id as string;
    expect(incidentId).toBeTruthy();

    const firstVoteSeen = waitFor(wsB, (m) => m.type === "vote:cast" && m.incidentId === incidentId);
    wsA.send(JSON.stringify({ type: "vote", incidentId, severity: 4, likelihood: 3 }));
    const firstVote = await firstVoteSeen;
    expect(firstVote.severity).toBe(4);
    expect(firstVote.likelihood).toBe(3);

    // A duplicate vote from the same session should be dropped, not
    // broadcast as an update — assert no second vote:cast for this session
    // arrives within a short window.
    let sawDuplicate = false;
    const duplicateWatch = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "vote:cast" && msg.incidentId === incidentId && msg.severity === 9) sawDuplicate = true;
    };
    wsB.on("message", duplicateWatch);
    wsA.send(JSON.stringify({ type: "vote", incidentId, severity: 9, likelihood: 9 }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    wsB.off("message", duplicateWatch);
    expect(sawDuplicate, "a duplicate vote on the same threat should not overwrite the first").toBe(false);
  } finally {
    wsA.close();
    wsB.close();
    wsC.close();
  }
});
