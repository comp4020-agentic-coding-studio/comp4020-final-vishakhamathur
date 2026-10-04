import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

async function analystCookie(): Promise<string> {
  const res = await fetch(new URL("/", baseUrl));
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

it("lets an analyst report a threat and vote on it", async () => {
  const cookie = await analystCookie();

  const createRes = await fetch(new URL("/api/incidents", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      title: "Spec test incident",
      description: "Created by spec/incidents.test.ts",
      category: "network",
    }),
  });
  expect(createRes.status).toBe(201);

  const stateRes = await fetch(new URL("/api/state", baseUrl), { headers: { cookie } });
  const state = (await stateRes.json()) as { openIncidents: { id: string; title: string; votes: unknown[] }[] };
  const incident = state.openIncidents.find((i) => i.title === "Spec test incident");
  expect(incident, "the created incident should appear in open incidents").toBeTruthy();

  const voteRes = await fetch(new URL(`/api/incidents/${incident!.id}/vote`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ severity: 4, likelihood: 3 }),
  });
  expect(voteRes.status).toBe(200);

  const afterVoteRes = await fetch(new URL("/api/state", baseUrl), { headers: { cookie } });
  const afterVote = (await afterVoteRes.json()) as {
    openIncidents: { id: string; votes: { severity: number; likelihood: number }[] }[];
  };
  const voted = afterVote.openIncidents.find((i) => i.id === incident!.id);
  expect(voted?.votes, "the vote should be recorded against the incident").toContainEqual(
    expect.objectContaining({ severity: 4, likelihood: 3 }),
  );
});
