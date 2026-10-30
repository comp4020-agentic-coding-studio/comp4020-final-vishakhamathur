# Process overview

An architecture-decision record for the Cyber Threat Consensus Board,
rewritten (not appended to) for the final project pivot to a round-based
social-deduction game.

## Fixed constraints

The app has to be multi-user, real-time (a vote reaches other open sessions
in about a second, no reload), and persistent across restarts and
redeploys. Course infrastructure is also fixed: one Fly.io machine, 256MB
of memory, one `/data` volume as the only thing that survives a redeploy,
no separate database server. Together these rule out an external database,
any build step that could drift between laptop and image, and any
framework whose main value is scaling past a handful of concurrent
analysts in a crit room.

## The stack, briefly

- **Runtime**: plain `.ts` on Node 24 via built-in type stripping — no
  bundler, no `tsc` step, nothing that can pass locally and fail in the
  image. Cost: only erasable syntax, so plain interfaces and
  string-literal unions throughout.
- **HTTP**: plain `node:http` — route count doesn't justify a framework.
- **Real-time**: `ws`, not SSE or polling — bidirectional and sub-second,
  no native addons. Every state change broadcasts immediately through one
  `Hub` (`server/ws.ts`); the only thing a client pulls is the one-time
  `hello` snapshot on connect.
- **Persistence**: `node:sqlite`'s `DatabaseSync` — real queries and
  transactional safety without a native-compile step. One file at
  `${DATA_DIR}/app.db`, `DATA_DIR` pointing at `/data` in production.
- **Frontend**: vanilla HTML/CSS/JS, no bundler — a CSS Grid risk matrix
  (100 cells, dots layered on top) rather than canvas. Sections re-render
  on each WebSocket message.
- **Identity**: a signed cookie (UUID + HMAC, secret persisted on
  `/data`), not accounts.
- **Consensus**: `server/consensus.ts` stays pure functions over `Vote[]`,
  kept out of request handlers so it's testable alone.

## The pivot: a round-based social-deduction game

**The question**: the final pass needs maximum live, in-person engagement
for a class presentation, plus strict server-side authorization and
detailed server-side logging, narratable start to finish from the terminal
alone. The prior build (an endless stream of 15-second threats with a
per-round Secret Saboteur overlay) never actually *ended* — no round
boundary, no winner, nothing forcing the room's attention to one shared
moment. That's a weaker fit for a timed demo than a game with a clear
start, middle, and resolution.

**What changed**: the whole game loop was replaced, not layered on top.
The continuous generator loop, the moderator role, the leaderboard/
agreement-rate/insider-flag bookkeeping, and the report-your-own-incident
queue are gone. `server/index.ts` now runs a single finite-state round:
`lobby → threat (×3) → audit → resolved`, tracked in module-level state
(`gamePhase`, `insiderId`, `threatIndex`, `auditVotes`, `lastResult`) —
in-memory, not persisted, because a round is a single live session's
concern, not something that needs to survive a restart mid-game.
`server/types.ts`'s `GameSnapshot`/`ServerMessage`/`ClientMessage` unions
are the wire protocol; `GET /api/game/state` mirrors the current snapshot
over REST for testability without a WS client.

**Authorization, strictly server-side, at every boundary**:

1. **Starting a shift** requires at least 3 currently-connected WebSocket
   sessions, checked against `hub.connectedAnalystIds()` — the server's own
   live connection list, never a client's claim.
2. **One triage vote per session per threat** — `Db.insertVote` rejects a
   second `(incident, analyst)` row outright, and `castVote` also rejects
   a vote that doesn't name the currently active incident, so a stale
   client replaying an old threat's vote after the phase has moved on is
   rejected too.
3. **One audit vote per session per round** — a map from voter id to
   target id, checked before insertion, with the only other rule being
   that the target must be a currently-connected session.
4. **The Insider Threat's identity is never sent to any client except
   that client's own role message** — `gameSnapshotFor` computes
   `roleFor(analystId)` per-recipient, and the `[ROLE]` log line
   deliberately omits who was assigned until `[EJECTED]` reveals it.

Every rejection (duplicate vote, out-of-range values, voting outside the
active window, a lobby start attempted without quorum) is both logged to
the durable `action_log` table and narrated to the terminal, so a
hand-crafted request that tries to skip any of these gets the same
rejection the UI would have prevented, and it's visible in the log either
way — never silently dropped.

**Ejection tie-break**: `finishAudit` picks the single highest vote count;
a tie at the top (including an all-zero tie) resolves to "nobody ejected"
rather than picking arbitrarily, and the Insider Threat wins by default
per the game's own rule — there's no incentive for an unresolved board to
feel like a bug.

**The log line shapes are fixed to an exact baseline** this pass
specifies as a requirement, not left to a looser "reads as a sentence"
convention: `[JOIN]`, `[ROLE] Assigned INSIDER THREAT to: {codename}`,
`[VOTE] {codename} locked in Sev: {x}, Lik: {y}.`, `[DENIED] {codename}
attempted to vote twice on same threat.`, `[AUDIT STARTED]`, `[AUDIT VOTE]
{A} voted to revoke {B}.`, and `[EJECTED] {codename} was ejected. They
WERE/WERE NOT the Insider Threat.` Every one of these has a matching
`db.logAction` call writing the durable row: the database row is the
queryable record, the console line is the live narration interface a
presenter reads straight off `flyctl logs`.

**What was deliberately dropped**: the leaderboard, agreement-rate, and
insider-flag-from-voting-patterns mechanics all depended on an ongoing
history of resolved incidents to score against — a notion of a "good
analyst" across many rounds. A one-shot social-deduction game doesn't have
that; its score is binary, once, at the end of a shift. `analysts` lost
its stats columns and `consensus.ts` lost `analystAgreements` entirely;
`resolveConsensus` itself is unchanged, since each threat's
true/false-positive call is still useful flavor during triage even though
it's no longer the point of the game.

**Playing again**: `game:play-again` resets every round-scoped variable
and returns the room to `lobby`, so a class can run several shifts back to
back without restarting the process.

## What I'd revisit

The round state machine is currently five module-level `let`s threaded
through free functions in `server/index.ts` — the fastest way to get a
correct, narratable state machine in place for this pass, but already
pushing on "too much shared mutable state in one file." If a future pass
adds more phases or more than one concurrent room, this should become a
proper class the way `Hub`/`Db` already are. The tie-handling rule in
`finishAudit` is a judgment call with no brief-mandated answer; a future
pass might want a runoff vote instead. The consensus/outlier scoring in
`server/consensus.ts` is unchanged from an earlier pass and still a
deliberately simple first draft — it's flavor text for this game now, not
the thing being evaluated.
