import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

it("issues a stable analyst identity via a cookie", async () => {
  const first = await fetch(new URL("/", baseUrl));
  const setCookie = first.headers.get("set-cookie");
  expect(setCookie, "GET / should set an analyst_id cookie for a new visitor").toBeTruthy();
  const cookie = setCookie!.split(";")[0]!;

  const meRes = await fetch(new URL("/api/me", baseUrl), { headers: { cookie } });
  const me = (await meRes.json()) as { id: string; codename: string };
  expect(me.codename).toMatch(/^Agent /);

  const meAgainRes = await fetch(new URL("/api/me", baseUrl), { headers: { cookie } });
  const meAgain = (await meAgainRes.json()) as { id: string; codename: string };
  expect(meAgain.id, "the same cookie should resolve to the same analyst").toBe(me.id);

  const strangerRes = await fetch(new URL("/api/me", baseUrl));
  const stranger = (await strangerRes.json()) as { id: string; codename: string };
  expect(stranger.id, "a request with no cookie should get a different analyst").not.toBe(me.id);
});
