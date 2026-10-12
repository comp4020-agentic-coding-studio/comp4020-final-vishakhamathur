# Process overview

This is an architecture-decision record for the stack behind the Cyber
Threat Consensus Board, written for crit 9 and expected to be rewritten (not
appended to) as the app and my understanding of it change.

## Fixed constraints

The app has to be multi-user, real-time (a vote reaches other open sessions
in about a second, no reload), and persistent across restarts and
redeploys. Course infrastructure is also fixed: one Fly.io machine, 256MB
of memory, one `/data` volume as the only thing that survives a redeploy,
no separate database server. Together these ruled out an external database
(nowhere to run one, no memory to spare anyway), any build step that could
drift between my laptop and the Docker image, and any framework whose main
value is scaling past a handful of concurrent analysts in a crit room.

## The stack, briefly

- **Runtime**: plain `.ts` on Node 24, run directly via built-in type
  stripping — no bundler, no `tsc` step, nothing that can pass locally and
  fail in the image. Cost: only *erasable* syntax (no enums, no decorators),
  so plain interfaces and string-literal unions throughout.
- **HTTP**: plain `node:http`, not a framework — five routes and one
  WebSocket upgrade don't justify Express/Fastify's routing abstraction.
- **Real-time**: `ws`, not SSE or polling — the requirement is bidirectional
  and sub-second, and no native addons are needed, so nothing breaks
  building on Alpine. Every state change (a vote, the active threat
  swapping, a resolution, the queue length) broadcasts immediately through
  one `Hub` (`server/ws.ts`); the only thing a client ever *pulls* is the
  one-time `hello` snapshot it gets on connecting or reconnecting.
- **Persistence**: `node:sqlite`'s `DatabaseSync`, not `better-sqlite3` or a
  JSON file — real queries and transactional safety (upserting a vote,
  resolving an incident and updating every analyst's stats atomically)
  without a native-compile step. One file at `${DATA_DIR}/app.db`,
  `DATA_DIR` pointing at `/data` in production.
- **Frontend**: vanilla HTML/CSS/JS, no bundler — one shared focus panel
  built around a CSS Grid risk matrix (100 cells, dots layered on top,
  updating live on slider `input` events) rather than canvas or a charting
  library. Whole sections re-render on each WebSocket message; simpler to
  reason about than it is slow, at this scale.
- **Identity**: a signed cookie (UUID + HMAC, keyed by a secret persisted on
  `/data`), not accounts — analysts need to be distinguishable, not logged
  in.
- **Consensus**: `server/consensus.ts` stays pure functions over `Vote[]`,
  kept out of the request handlers so it's testable on its own. Severity
  and likelihood moved from a 1-5 to a 1-10 scale this crit, to back a true
  10x10 risk-matrix grid; the scale-dependent constants (`MAX_STDEV`,
  `MAX_DEVIATION`, the true/false-positive product threshold) were rescaled
  proportionally, same shape of logic as the first draft.

## Crit 9 decision: one shared active threat, not several concurrent ones

**The question**: what happens when several people use the app at once —
what's visible to everyone live, and what a reconnecting or late-arriving
analyst sees.

**What changed**: through crit 8, up to five incidents could be open at
once, and each analyst picked whichever to vote on from a feed. Playtesting
felt like reading an inbox, not watching a room converge — analysts in the
same session were often looking at different incidents entirely, so there
was no shared moment where "the room" agreed or disagreed about anything. I
replaced that with **Focus Mode**: exactly one incident is ever active. A
strict 15-second timer resolves it (averaging whatever votes came in, or
filing it `"ignored"` if nobody voted), then the next one starts
immediately — pulled from a FIFO queue of analyst-submitted reports if one
is waiting, otherwise freshly generated.

**Alternatives considered**:

1. **Keep multiple concurrent incidents** (the crit 8 status quo). Closer
   to a real SOC, where alerts queue in parallel and a room of five could
   triage five at once for higher throughput. Rejected because it doesn't
   produce what `README.md` defines as "good": consensus has to be
   *visible*, which requires everyone looking at the same thing at the
   same time, not a shared database that's visible to everyone separately.
2. **Per-analyst private queues** (each visitor served incidents in their
   own order). Rejected outright — it breaks the "room" framing entirely,
   since no two analysts would ever be looking at the same incident at the
   same moment.
3. **Focus Mode** (chosen): one incident, everyone on it, reports queue
   behind it rather than competing for attention.

**What this means for the brief's four questions**:

- *Live vs. reload*: every vote, active-threat swap, resolution, and queue
  change broadcasts instantly; a reload only matters for a client that was
  never connected, which gets the current snapshot via `hello`.
- *Presence*: no explicit presence list, but every vote broadcasts with the
  voting analyst's codename and lands as a dot on the shared matrix
  immediately — "who's voting, and where" is presence as a side effect of
  voting itself.
- *Simultaneous changes*: two analysts voting on the same incident at once
  don't conflict — `upsertVote` is keyed by `(incident, analyst)`, so votes
  are independent, no shared field to race over. Two reports submitted in
  the same second both queue, FIFO by insertion order, no data lost either
  way.
- *Reconnect / next day*: the server has no notion of "where a client left
  off" — every new connection gets a fresh `hello` built from current
  truth, so reconnecting always shows the room's current state, never a
  stale replay.

**Tradeoff accepted**: Focus Mode trades incident throughput for shared
attention. At the scale the brief and `README.md` target — a handful of
analysts, an incident every ~15 seconds — that's the right trade; it would
not scale to a much larger room, where a long report queue and idle
analysts waiting their turn would become a real cost. That's a deliberate
non-goal here, not an oversight.

## What I'd revisit

The consensus and insider-threat scoring is still a deliberately simple
first pass, now rescaled to 1-10 but not otherwise re-examined since crit
8. The 15-second resolution window is an untested guess, picked to keep
Focus Mode feeling continuous rather than for any principled reason; crit
feedback on whether a room can actually deliberate in that time is the
thing most likely to change it next.
