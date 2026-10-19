import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// The moderator is whichever analyst was created first, ever — in a running
// app with any history at all, a brand-new visitor is never that analyst, so
// this is a reliable way to exercise the denial path without needing to
// reset the database.
it("rejects a moderator-only action from a non-moderator analyst", async () => {
  const first = await fetch(new URL("/", baseUrl));
  const setCookie = first.headers.get("set-cookie");
  const cookie = setCookie!.split(";")[0]!;

  const meRes = await fetch(new URL("/api/me", baseUrl), { headers: { cookie } });
  const me = (await meRes.json()) as { id: string; codename: string };
  expect(me.id).toBeTruthy();

  const resolveRes = await fetch(new URL("/api/moderator/resolve-now", baseUrl), {
    method: "POST",
    headers: { cookie },
  });
  expect(resolveRes.status, "a non-moderator hitting the moderator-only route should get a 403").toBe(403);
  const body = (await resolveRes.json()) as { ok: boolean };
  expect(body.ok).toBe(false);
});

it("rejects the same action for an unauthenticated request", async () => {
  const resolveRes = await fetch(new URL("/api/moderator/resolve-now", baseUrl), { method: "POST" });
  expect(resolveRes.status).toBe(403);
});
