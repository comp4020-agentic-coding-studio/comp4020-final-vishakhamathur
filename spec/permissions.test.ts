import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

async function analystCookie(): Promise<string> {
  const res = await fetch(new URL("/", baseUrl));
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

// Starting a shift is gated on a real quorum of currently-connected
// sessions, checked server-side against the live connection list — a lone
// visitor hitting the route directly should never be able to force a start.
it("rejects starting a shift without enough connected players", async () => {
  const cookie = await analystCookie();

  const stateRes = await fetch(new URL("/api/game/state", baseUrl), { headers: { cookie } });
  const stateBefore = (await stateRes.json()) as { phase: string; players?: { id: string }[] };

  // Only meaningful to assert in a lobby with fewer than 3 live WS
  // connections, which is the state a fresh spec run's HTTP-only client
  // (no WS upgrade) finds the app in.
  if (stateBefore.phase !== "lobby" || (stateBefore.players?.length ?? 0) >= 3) return;

  const startRes = await fetch(new URL("/api/game/start", baseUrl), {
    method: "POST",
    headers: { cookie },
  });
  expect(startRes.status, "starting with fewer than 3 connected sessions should be rejected").toBe(400);
  const body = (await startRes.json()) as { ok: boolean };
  expect(body.ok).toBe(false);
});

it("rejects a vote outside the active threat window", async () => {
  const cookie = await analystCookie();

  const voteRes = await fetch(new URL(`/api/incidents/not-a-real-incident/vote`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ severity: 4, likelihood: 3 }),
  });
  expect(voteRes.status, "a vote naming no active threat should be rejected, not just no-opped").toBe(400);
});

it("rejects an audit vote outside the audit phase", async () => {
  const cookie = await analystCookie();

  const stateRes = await fetch(new URL("/api/game/state", baseUrl), { headers: { cookie } });
  const state = (await stateRes.json()) as { phase: string };
  if (state.phase === "audit") return;

  const auditRes = await fetch(new URL("/api/game/audit-vote", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ targetId: "someone" }),
  });
  expect(auditRes.status, "an audit vote outside the audit phase should be rejected").toBe(400);
});
