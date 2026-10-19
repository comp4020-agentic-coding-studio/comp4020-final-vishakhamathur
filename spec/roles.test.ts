import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// The Secret Saboteur role is in-memory, reassigned every round, and never
// changes what the server will accept from an analyst — this just checks
// that /api/state always reports a valid role for whoever asks.
it("reports a role for every analyst", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;

  const stateRes = await fetch(new URL("/api/state", baseUrl), { headers: { cookie } });
  const state = (await stateRes.json()) as { role: string };
  expect(["analyst", "saboteur"]).toContain(state.role);
});
