# Your harness

Rules for working on the Cyber Threat Consensus Board, derived from the
argument in `README.md` and the decisions in `PROCESS.md`. These are what I
hold the agent to; see `spec/README.md` for what's mechanically fixed by the
course instead.

- **No build step.** The server runs as plain `.ts` files under Node's
  built-in type stripping. Don't introduce a bundler, `tsc` compile step, or
  any dependency that only works after a build — the whole point is that
  what runs locally is what ships.
- **No framework for framework's sake.** `node:http` and `ws` cover the
  app's actual surface. Don't reach for Express/Fastify/a frontend framework
  unless the route count or interaction complexity has actually outgrown
  plain handlers — justify it in `PROCESS.md` if so, don't just add it.
- **Everything that must persist lives under `DATA_DIR`.** Only `/data`
  survives a Fly redeploy. Any new state that needs to survive one — new
  tables, the identity secret, anything — goes through `server/db.ts` or
  reads/writes inside `DATA_DIR`, never a path outside it.
- **`spec/invariants.test.ts` is untouchable.** It's the course's fixed
  contract (`/` returns 200, `/readme/` renders `README.md`'s headings in
  order). Any new spec lives in its own `spec/*.test.ts` file instead.
- **Real-time means the WebSocket broadcast, not a poll.** New live-updating
  behavior goes through `Hub.broadcast` in `server/ws.ts` with a typed
  message in `server/types.ts`, mirrored as a REST fallback only when it
  makes the behavior testable from `spec/`.
- **Consensus/scoring logic stays pure and in `server/consensus.ts`.** It's
  explicitly a first draft (see `PROCESS.md`); changing the thresholds or
  the algorithm is fine, but keep it as pure functions over votes, not
  inlined into request handlers, so it stays testable and explainable.
- **`PROCESS.md` gets rewritten each crit, not appended to.** It should
  always read as the current, true account of the stack and its trade-offs,
  not a changelog.
- **Never commit secrets or local state.** `data/` (local SQLite file and
  identity secret) and `mise.local.toml` (the Fly token) stay gitignored.
  Don't add code that writes persisted data anywhere else in the repo.
