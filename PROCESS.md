# Process overview

This is an architecture-decision record for the stack behind the Cyber
Threat Consensus Board, written for crit 9 and expected to be rewritten (not
appended to) as the app and my understanding of it change.

## The brief's fixed requirements, and what they rule out

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
version. That means the server has zero build tooling: no `tsc` compile
step, no bundler, no `ts-node` dependency, and nothing that can pass locally
and fail in the Docker image because a build config differs. The cost is
that type stripping only accepts *erasable* syntax — no enums, no
constructor parameter properties, no decorators — so the code sticks to
plain interfaces, string-literal unions instead of enums, and fields
assigned in constructor bodies instead of parameter-property shorthand.

## HTTP: plain `node:http`, not a framework

The whole app is about five routes (`/`, `/readme/`, two static files, a
handful of `/api/*` endpoints) plus one WebSocket upgrade. Express, Fastify,
or Hono would add a dependency and a routing abstraction for a surface this
small, and the one place a framework often earns its keep — the WebSocket
upgrade handshake — is a handful of lines against Node's own `http.Server`
`'upgrade'` event.

## Real-time: WebSockets over the `ws` library, not SSE or polling

The requirement is bidirectional and sub-second: analysts both receive
other people's votes and send their own, and incidents can be created from
either the server (the generator) or a client (an analyst's report). `ws` is
the standard, minimal choice; no native addons are required at this scale,
so there's nothing to break building on Alpine. Everything that changes
shared state — a vote, the active threat swapping, a resolution, a queue
length change — broadcasts immediately through one `Hub` (`server/ws.ts`);
the only thing a client ever has to *pull* is the full snapshot it gets once,
in the `hello` message, when it first connects or reconnects.

## Persistence: `node:sqlite`, not `better-sqlite3`, not a JSON file

The data (incidents, votes, per-analyst track records) is relational enough
to want real queries and a bit of transactional safety — upserting a vote,
or resolving an incident and updating every voting analyst's stats
atomically — which a hand-rolled JSON file on disk would make fiddly and
easy to corrupt under concurrent writes. `node:sqlite`'s `DatabaseSync`,
built into this Node version, gives SQLite without a native-compile step.
The whole database is one file at `${DATA_DIR}/app.db`, `DATA_DIR` pointing
at `/data` in production — exactly the one thing in the Fly setup that
survives a redeploy.

## Frontend: vanilla HTML/CSS/JS, no framework, no bundler

For a page built around one shared focus panel (a threat card, a 10x10 risk
matrix, a countdown, a report form, a leaderboard), a frontend framework
buys very little and a bundler buys nothing at all. The risk matrix is a
CSS Grid of 100 cells with absolutely-positioned dots layered over it,
rather than a canvas or a charting library — simple to reason about at this
scale, and dots update live on slider `input` events without waiting for a
server round trip. The main cost is more manual DOM-diffing than a framework
would give for free; re-rendering the whole active-threat card on each
WebSocket message is simpler to reason about than it is slow, at the one
incident and handful-of-analysts scale this app targets.

## Identity: a signed cookie, not accounts

"Multi-user" here means analysts are distinguishable, not that they log in.
A cookie holding a UUID plus an HMAC signature (keyed by a secret generated
once and persisted alongside the database on `/data`) gets a stable identity
across reconnects and restarts without a password or an account table.

## Consensus/scoring: pure functions over a 1-10 scale

`server/consensus.ts` stays pure functions over `Vote[]`, kept separate from
the request handlers so it's testable and explainable on its own. Severity
and likelihood moved from a 1-5 to a 1-10 scale this crit, to back a true
10x10 risk-matrix grid (one cell per value) rather than a 5x5 grid rendered
at double resolution. The thresholds that depend on the scale's width
(`MAX_STDEV`, `MAX_DEVIATION`, the true/false-positive product cutoff)
were rescaled proportionally; the shape of the logic — mean position,
stdev-based agreement, per-vote deviation for the insider-outlier flag — is
unchanged from the first draft.

## Crit 9 decision: one shared active threat, not several concurrent ones

**The question the brief asks**: what happens when several people use the
app at once — specifically, what's visible to everyone live, and what a
reconnecting or late-arriving analyst sees.

**What changed**: through crit 8, up to five incidents could be open at
once, and each analyst picked whichever one(s) to vote on from a feed.
Playtesting this draft felt like reading an inbox, not watching a room
converge — multiple analysts in the same session were often looking at
different incidents entirely, so there was no single moment where "the
room" agreed or disagreed about anything. I replaced that with **Focus
Mode**: exactly one incident is ever active. A strict 15-second timer
resolves it (averaging whatever votes came in, or filing it `"ignored"` if
nobody voted), then the next one starts immediately — pulled from a FIFO
queue of analyst-submitted reports if one is waiting, otherwise freshly
generated.

**Alternatives considered**:

1. **Keep multiple concurrent incidents** (the status quo through crit 8).
   Closer to a real SOC, where alerts queue up in parallel and analysts
   triage several at once — a room of five analysts could in principle
   evaluate five incidents simultaneously, for higher total throughput than
   Focus Mode allows. Rejected because it doesn't produce the thing
   `README.md` defines as "good": consensus has to be *visible*, and that
   requires everyone looking at the same thing at the same time, not a
   shared database that happens to be visible to everyone separately.
2. **Per-analyst private queues** (each visitor gets served incidents in
   their own order, independent of everyone else). Rejected outright —
   it breaks the "room" framing entirely, since under this model no two
   analysts are ever even looking at the same incident at the same moment,
   so no shared consensus is possible by construction.
3. **Focus Mode** (chosen): one incident, everyone on it, reports queue
   behind it rather than competing for attention.

**What this means concretely, for the brief's four questions**:

- *What reaches other people live, and what waits for reload*: every vote,
  the active threat changing, a resolution, and the queue length all
  broadcast over the WebSocket the instant they happen. Nothing in the live
  session requires a reload; a reload only matters for a client that was
  never connected, which gets the current snapshot via `hello`.
- *Whether people can see who else is here*: not directly (no presence
  list) — but every vote is broadcast with the voting analyst's codename
  attached, and lands as a dot on the shared risk matrix immediately, so
  "who's voting, and where" is visible as a side effect of voting itself,
  which is the form of presence the app actually cares about.
- *What happens when two people change the same thing at once*: two
  analysts voting on the same incident in the same instant don't conflict —
  `upsertVote` is keyed by `(incident, analyst)`, so each analyst's own vote
  is independent of everyone else's; there's no shared field for two people
  to race over. Two analysts submitting a report in the same second both
  queue, FIFO by insertion order — arbitrary but stable, no data lost
  either way, and nobody's report ever pre-empts the incident currently
  live.
- *What someone sees when they reconnect, or come back the next day*: the
  server has no notion of "where a client left off" — every new WebSocket
  connection gets a fresh `hello` built from current truth (whichever
  incident is active right now, current queue length, the last 20 resolved
  incidents, the whole leaderboard), so a reconnect or a next-day visit
  always shows the current state of the room, never a stale replay.

**Tradeoff accepted**: Focus Mode deliberately trades incident throughput
for shared attention. At the scale the brief and `README.md` target — a
handful of concurrent analysts, an incident every ~15 seconds — that's the
right trade: everyone converging on one judgment together is the point of
the app. It would not scale to a much larger room, where a long reported-
incident queue and idle analysts waiting their turn would become a real
cost; that's a deliberate non-goal here, not an oversight.

## What I'd revisit

The consensus and insider-threat scoring is still a deliberately simple
first pass — population-stdev-based agreement, a fixed product threshold
for true vs. false positive, a fixed deviation cutoff for an outlier vote —
now rescaled to 1-10 but not otherwise re-examined since crit 8. The
15-second resolution window is also an untested guess: it was picked to
keep Focus Mode feeling continuous rather than for any principled reason,
and crit feedback on whether it's too fast or too slow for a room to
actually deliberate is the thing most likely to change it next.
