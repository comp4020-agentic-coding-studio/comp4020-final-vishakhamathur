import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// Round roles (ANALYST / INSIDER_THREAT) only exist once a shift is running;
// before that, /api/game/state reports the lobby phase. This just checks the
// snapshot shape is always one of the phases the game protocol defines, for
// whoever asks, logged in or not.
it("reports a valid game phase for every visitor", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;

  const stateRes = await fetch(new URL("/api/game/state", baseUrl), { headers: { cookie } });
  const state = (await stateRes.json()) as { phase: string };
  expect(["lobby", "threat", "audit", "resolved"]).toContain(state.phase);
});
