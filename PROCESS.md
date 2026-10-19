# Process overview

This is an architecture-decision record for the stack behind the Cyber
Threat Consensus Board, written for crit 10 and expected to be rewritten
(not appended to) as the app and my understanding of it change.

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
- **HTTP**: plain `node:http`, not a framework — the route count, including
  the new moderator route added this crit, still doesn't justify
  Express/Fastify's routing abstraction.
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
  kept out of the request handlers so it's testable on its own.

## Crit 10: roles, permissions, and the action log

**The question**: the brief for this crit requires two visitors, in two
browser profiles with no shared cookies, to be told apart by the server with
a real permission boundary between them — and for the server to log who did
what, in a way that survives the crit.

**What changed**: the app was previously flat — every analyst, anonymous or
not, could vote and report incidents identically. I added a second role,
**Moderator**, and one moderator-only action: force the currently active
incident to resolve immediately instead of waiting out its 15-second
countdown (`POST /api/moderator/resolve-now`, mirrored as a
`moderator:resolve-now` WS message for the same action from an already-open
socket).

**Who is the moderator, and why derived rather than stored**: the moderator
is whichever analyst row has the earliest `created_at` (ties — same
millisecond — broken by SQLite's implicit `rowid`, which still reflects
insertion order even though `id` is a UUID primary key and sorts
independently of when the row was actually inserted). This is computed
fresh on every request (`Db.isModerator`) rather than stored as a column on
the analyst, and deliberately not trusted from anything the client sends.
Two reasons:

1. **Spoofing.** A boolean `isModerator` column could, in principle, be
   accepted as part of a client payload by a careless handler and trusted
   outright. Deriving it from a server-owned, append-only history (who was
   created when) removes that failure mode entirely — there is no field to
   forge.
2. **Survivability.** The brief requires the two-tester demo to work
   against the *deployed* app after however many redeploys happened before
   the crit. `created_at` already lives in the `analysts` table, which is
   already the thing that survives a Fly redeploy (it's under `/data`), so
   this adds zero new persistence surface — no migration, no new column, no
   new failure mode on restart.

**Alternatives considered**:

1. **A stored `role` column, settable via an admin endpoint.** More
   flexible (supports more than one moderator, or handing off the role),
   but needs its own authorization story — who's allowed to grant
   moderator? — and that bootstrapping problem is exactly the thing
   "earliest visitor" sidesteps for free. Rejected for this crit as solving
   a problem the brief didn't ask for.
2. **Session-based role (first WS connection of the current server
   process).** Simpler, but fails the "survives redeploy" requirement
   outright — a Fly restart would silently reassign the role mid-crit.
   Rejected.
3. **Earliest-created analyst, derived on every check** (chosen). No new
   persistence, no spoofable field, survives restarts because it's read
   from the same table that already does.

**Enforcement**: both the REST route and the WS message path call
`db.isModerator(analyst.id)` directly in `server/index.ts` before doing
anything — a non-moderator gets a 403 over REST (`spec/permissions.test.ts`
checks this for both a fresh analyst and no cookie at all) or is silently
ignored over the WS path, logged either way as `resolve-now:denied`. The
frontend (`public/app.js`) also hides the "Resolve now" button for
non-moderators, but that's cosmetic — removing it client-side changes
nothing about what the server will accept, which is the actual point: a
curious tester popping devtools and hand-crafting the POST gets the same
403 as the UI gives everyone else.

**Persistent, attributable logging**: every vote, report, and moderator
action writes a row to a new `action_log` table (`server/db.ts`) — who
(`analyst_id`, `codename`), what (`action`, free-text `detail`), and when.
This is append-only and lives under `/data`, so it outlives both the
process and the crit, per the brief's requirement that the log "persist
beyond the crit itself."

**Live narration, separately**: `db.logAction` only writes the durable
database row; a parallel `narrate()` helper in `server/index.ts` writes a
human-readable line to stdout at the same call sites, tagged by event type
— `[START]`, `[JOIN]`/`[LEAVE]` (WS connect/disconnect), `[NEW]` (first-time
identity), `[THREAT]` (a new incident goes active), `[VOTE]`, `[DENIED]`
(covers every rejection: duplicate vote, out-of-range vote, voting on a
closed incident, a non-moderator hitting the moderator route, an invalid
report), `[REPORT]`, `[MODERATE]`, `[RESOLVE]` (consensus level and which
side won), and `[FLAG]` (an analyst crosses the insider threshold). These
two are kept separate on purpose: the database row is the queryable,
structured record; the console line is the actual interface the crit's
narrate-from-`flyctl-logs` demo depends on, so it's written to read as a
sentence a presenter can say out loud without translating it first (e.g.
`[VOTE] User 'Agent Fox' voted Sev: 8, Lik: 4 on Threat ID: 7bedb61e`,
not a key=value dump).

## Crit 10: one vote per analyst per threat, strictly

**The question**: votes previously used upsert semantics — an analyst could
change their severity/likelihood on the active incident as many times as
they liked before it resolved. That's a softer guarantee than "one vote per
user per threat," and nothing stopped a vote arriving twice (double-click,
retried request, a second tab) from silently overwriting the first with no
record that a second attempt happened at all.

**What changed**: `Db.insertVote` (`server/db.ts`) replaces the old
`upsertVote` — it checks for an existing `(incident_id, analyst_id)` row
first and, if one exists, inserts nothing and returns `false`. `castVote`
in `server/index.ts` treats that `false` as a rejection: the REST route
responds `400`, the WS path simply doesn't broadcast a `vote:cast`, and
either way a `vote:denied` row is logged (`detail=... reason=already-voted`)
so a duplicate attempt is visible in the action log, not just silently
dropped. The identity used for the check is always the server-verified one
from `resolveIdentity`/the WS upgrade's cookie check — never anything the
client's message body claims — so this is the same server-side-identity
guarantee the moderator check relies on, applied to voting instead.

**Why reject instead of ignore-and-return-200**: a client that thinks its
second vote succeeded (because it got a 200) would show a vote that never
actually recorded, which is worse than an honest error — the frontend
(`public/app.js`) now disables the sliders and renders "Vote locked in"
once `votes` contains the analyst's own id, so the UI stops inviting a
second attempt in the first place. That's cosmetic, the same way hiding
"Resolve now" is: a hand-crafted second `POST` still gets a 400 regardless
of what the UI shows.

**Tradeoff accepted**: this removes the "change your mind before it
resolves" affordance that upsert gave analysts. For a 15-second window
that's a small loss, and a strict one-vote rule is unambiguous to test and
to narrate from logs, which matters more for this crit's demo than vote
correction would.

## What I'd revisit

The moderator role is deliberately minimal — one role, one gated action —
to keep the permission boundary legible for the crit's two-tester demo
rather than building out a fuller admin surface nobody asked for yet. If a
future crit wants more than one gated action, the `isModerator`-style check
repeated at each call site (REST + WS) should probably become a small
shared guard instead, which is the first thing I'd refactor if a third
moderator-only action showed up. The consensus and insider-threat scoring
itself is unchanged from crit 9 and still a deliberately simple first pass.
