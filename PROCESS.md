# Process overview

This is an architecture-decision record for the stack behind the Cyber
Threat Consensus Board, written for crit 8 and expected to be rewritten (not
appended to) as the app and my understanding of it change.

## The brief's three fixed requirements, and what they rule out

The app has to be multi-user (analysts distinguished from each other),
real-time (a vote has to reach other open sessions in about a second, no
reload), and persistent across restarts and redeploys. The course
infrastructure is also fixed: one Fly.io machine, 256MB of memory, one
`/data` volume as the only thing that survives a redeploy, and no separate
database server in the course setup. Those two sets of constraints together
ruled out more than they allowed:

- No external database (Postgres, Redis) — there's nowhere in the course
  setup to run one, and a 256MB machine has no room to spare for one anyway.
- No build step that can silently drift between my laptop and the Fly
  image — the whole point of a from-scratch week-by-week build is that what
  I test locally is what ships.
- No framework whose main value is scaling past what a few concurrent
  analysts in a crit room will ever produce.

## Runtime: TypeScript on Node, no transpiler

Node 24.21.0 (already pinned in `mise.toml` for the spec harness) runs `.ts`
files directly via its built-in type stripping — no flag needed on this
version. I confirmed this before committing to it: a plain `.ts` file with a
type annotation runs unmodified with `node file.ts`. That means the server
has zero build tooling: no `tsc` compile step, no bundler, no `ts-node`
dependency, and nothing that can pass locally and fail in the Docker image
because a build config differs. The cost is that type stripping only accepts
*erasable* syntax — no enums, no constructor parameter properties, no
decorators — so the code sticks to plain interfaces, string-literal unions
instead of enums, and fields assigned in constructor bodies instead of
parameter-property shorthand. That's a small, worthwhile discipline for the
speed and simplicity it buys.

## HTTP: plain `node:http`, not a framework

The whole app is about five routes (`/`, `/readme/`, two static files, a
handful of `/api/*` endpoints) plus one WebSocket upgrade. Express, Fastify,
or Hono would add a dependency and a routing abstraction for a surface this
small, and the one place a framework often earns its keep — the WebSocket
upgrade handshake — is a handful of lines against Node's own `http.Server`
`'upgrade'` event. I'd reach for a framework the moment the route count or
the middleware needs grew; they haven't.

## Real-time: WebSockets over the `ws` library, not SSE or polling

The requirement is bidirectional and sub-second: analysts both receive
other people's votes and send their own, and incidents can be created from
either the server (the generator) or a client (an analyst's report). SSE is
one-directional, which would mean a second channel (plain POSTs) for the
client-to-server half, splitting the real-time logic across two transports
for no benefit. Polling, even fast polling, trades implementation simplicity
for both latency and wasted requests against incidents that, most of the
time, nobody is actively voting on — the opposite of what the small-scale
framing in `README.md` is going for. `ws` is the standard, minimal choice; no
native addons are required at this scale, so there's nothing to break
building on Alpine.

## Persistence: `node:sqlite`, not `better-sqlite3`, not a JSON file

The data (incidents, votes, per-analyst track records) is relational enough
to want real queries and a bit of transactional safety — upserting a vote,
or resolving an incident and updating every voting analyst's stats
atomically — which a hand-rolled JSON file on disk would make fiddly and
easy to corrupt under concurrent writes. A full database server is out per
the constraints above. `node:sqlite`'s `DatabaseSync`, built into this
Node version, gives SQLite without a native-compile step — the classic
failure mode with `better-sqlite3` is a prebuilt binary mismatch against
Alpine's musl libc inside the Docker image, which `node:sqlite` sidesteps
entirely since it ships with Node itself. The whole database is one file at
`${DATA_DIR}/app.db`, `DATA_DIR` pointing at `/data` in production — exactly
the one thing in the Fly setup that survives a redeploy, so persistence is a
property of *where the file lives*, not of any sync or backup logic I had to
write.

## Frontend: vanilla HTML/CSS/JS, no framework, no bundler

For a one-page app with a handful of interactive widgets (vote sliders, a
risk-matrix scatter plot, a report form, a leaderboard table), a frontend
framework buys very little and a bundler buys nothing at all — there's no
code-splitting concern at this scale, and "no build step" was already the
guiding principle for the server. The risk matrix is hand-drawn inline SVG
rather than a charting library, since it's a dozen circles on two axes. The
main cost is more manual DOM-diffing than a framework would give for free;
at this scale (a handful of incidents, a handful of analysts) re-rendering
whole sections on each WebSocket message is simpler to reason about than it
is slow.

## Identity: a signed cookie, not accounts

"Multi-user" here means analysts are distinguishable, not that they log in —
`README.md` is explicit that this is meant to work for anyone who opens the
link. A cookie holding a UUID plus an HMAC signature (keyed by a secret
generated once and persisted alongside the database on `/data`) gets a
stable identity across reconnects and restarts without a password or an
account table, while still stopping a client from trivially claiming
someone else's track record by editing the cookie's content.

## What I'd revisit

The consensus and insider-threat scoring (`server/consensus.ts`) is a
deliberately simple first pass — population-stdev-based agreement, a fixed
0.6/9 threshold for true vs. false positive, a fixed 0.3 deviation for an
outlier vote. It's documented as a first draft in `README.md` and is the
most likely thing to change as crit 9 and 10 put real groups of people
through it and I see where the thresholds feel wrong.
