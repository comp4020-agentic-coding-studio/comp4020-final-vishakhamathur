import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { WebSocketServer } from "ws";
import { Db } from "./db.ts";
import { resolveConsensus } from "./consensus.ts";
import { generateThreat } from "./generator.ts";
import { analystCookieHeader, generateCodename, IdentitySigner, readAnalystCookie } from "./identity.ts";
import { renderReadmePage } from "./readme.ts";
import { Hub } from "./ws.ts";
import type { Analyst, ClientMessage, GamePhase, GameRole, GameSnapshot, PlayerInfo } from "./types.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const THREAT_DURATION_MS = Number(process.env.THREAT_DURATION_MS ?? 20_000);
const AUDIT_DURATION_MS = Number(process.env.AUDIT_DURATION_MS ?? 30_000);
const TOTAL_THREATS = 3;
const MIN_PLAYERS = 3;

const db = new Db(DATA_DIR);
const signer = new IdentitySigner(DATA_DIR);
const hub = new Hub();

// Live narration for the in-class demo: the presenter reads these off
// `flyctl logs` / the terminal while never touching the app, so every tag
// names an actor and every line is self-contained. `logAction` writes the
// durable, queryable record to `/data`; `narrate` is the human-readable
// stream read aloud live. Keep both in sync at each call site.
function shortId(id: string): string {
  return id.slice(0, 8);
}

function narrate(tag: string, message: string): void {
  console.log(`[${tag}] ${message}`);
}

function resolveIdentity(req: IncomingMessage, res: ServerResponse): Analyst {
  const cookie = readAnalystCookie(req);
  const verifiedId = cookie ? signer.verify(cookie) : undefined;

  if (verifiedId) {
    const existing = db.getAnalyst(verifiedId);
    if (existing) return existing;
    const created = db.createAnalyst(verifiedId, generateCodename());
    narrate("NEW", `User '${created.codename}' identified (Session: ${shortId(created.id)})`);
    return created;
  }

  const minted = signer.mint();
  res.setHeader("Set-Cookie", analystCookieHeader(minted.cookie));
  const created = db.createAnalyst(minted.id, generateCodename());
  narrate("NEW", `User '${created.codename}' identified (Session: ${shortId(created.id)})`);
  return created;
}

function codenameOf(id: string): string {
  return db.getAnalyst(id)?.codename ?? "Unknown";
}

function playerInfo(id: string): PlayerInfo {
  return { id, codename: codenameOf(id) };
}

function connectedPlayers(): PlayerInfo[] {
  return hub.connectedAnalystIds().map(playerInfo);
}

// --- Among Us-style round: lobby -> threat x3 -> audit -> resolved ---

let gamePhase: GamePhase = "lobby";
let insiderId: string | null = null;
let threatIndex = 0;
let currentIncidentId: string | null = null;
let phaseDeadline = 0;
let gameTimer: NodeJS.Timeout | null = null;
// voterId -> targetId. In-memory only, like the round itself — nothing here
// needs to survive a restart, a restart just means the in-flight round gets
// reset along with everything else.
let auditVotes = new Map<string, string>();
let lastResult: {
  ejectedId: string | null;
  ejectedCodename: string | null;
  wasInsider: boolean;
  winner: "ANALYSTS" | "INSIDER";
  insiderCodename: string;
} | null = null;

function roleFor(analystId: string): GameRole {
  return analystId === insiderId ? "INSIDER_THREAT" : "ANALYST";
}

function tally(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const targetId of auditVotes.values()) counts[targetId] = (counts[targetId] ?? 0) + 1;
  return counts;
}

function gameSnapshotFor(analystId: string): GameSnapshot {
  if (gamePhase === "lobby") {
    const players = connectedPlayers();
    return { phase: "lobby", players, readyToStart: players.length >= MIN_PLAYERS };
  }
  const role = roleFor(analystId);
  if (gamePhase === "threat") {
    const incident = db.getIncident(currentIncidentId!)!;
    return {
      phase: "threat",
      role,
      threatIndex,
      totalThreats: TOTAL_THREATS,
      deadline: phaseDeadline,
      active: db.incidentView(incident),
    };
  }
  if (gamePhase === "audit") {
    return { phase: "audit", role, deadline: phaseDeadline, candidates: connectedPlayers(), tally: tally() };
  }
  const r = lastResult!;
  return {
    phase: "resolved",
    role,
    ejectedId: r.ejectedId,
    ejectedCodename: r.ejectedCodename,
    wasInsider: r.wasInsider,
    winner: r.winner,
    insiderCodename: r.insiderCodename,
    youWereRevoked: r.ejectedId === analystId,
  };
}

function broadcastLobby(): void {
  if (gamePhase !== "lobby") return;
  const players = connectedPlayers();
  hub.broadcast({ type: "lobby:update", players, readyToStart: players.length >= MIN_PLAYERS });
}

// Authorization: only starts the round when at least MIN_PLAYERS distinct
// sessions are connected, and only from the lobby — enforced here, not just
// hidden client-side. Returns false (not a thrown error) for a precondition
// that isn't met, same convention as the rest of this file's action functions.
function startGame(initiator: Analyst): boolean {
  if (gamePhase !== "lobby") {
    db.logAction(initiator.id, initiator.codename, "game:start:denied", "reason=already-started");
    narrate("DENIED", `User '${initiator.codename}' attempted to start a round that's already in progress.`);
    return false;
  }
  const candidates = hub.connectedAnalystIds();
  if (candidates.length < MIN_PLAYERS) {
    db.logAction(initiator.id, initiator.codename, "game:start:denied", `reason=not-enough-players count=${candidates.length}`);
    narrate(
      "DENIED",
      `User '${initiator.codename}' tried to start the shift with only ${candidates.length} connected (need ${MIN_PLAYERS}).`,
    );
    return false;
  }

  insiderId = candidates[Math.floor(Math.random() * candidates.length)]!;
  for (const id of candidates) {
    hub.sendTo(id, { type: "game:role", role: roleFor(id) });
  }
  db.logAction(initiator.id, initiator.codename, "game:start", `players=${candidates.length}`);
  narrate("ROLE", `Assigned INSIDER THREAT to: ${codenameOf(insiderId)}`);

  threatIndex = 0;
  startThreat();
  return true;
}

function startThreat(): void {
  gamePhase = "threat";
  const threat = generateThreat();
  const incident = db.createIncident({
    id: randomUUID(),
    title: threat.title,
    description: threat.description,
    hint: threat.hint,
    category: threat.category,
  });
  currentIncidentId = incident.id;
  phaseDeadline = Date.now() + THREAT_DURATION_MS;

  hub.broadcast({
    type: "threat:new",
    incident: db.incidentView(incident),
    threatIndex,
    totalThreats: TOTAL_THREATS,
    deadline: phaseDeadline,
  });
  narrate(
    "THREAT",
    `New active threat (${threatIndex + 1}/${TOTAL_THREATS}) — ID: ${shortId(incident.id)} "${incident.title}"`,
  );

  gameTimer = setTimeout(() => finishThreat(incident.id), THREAT_DURATION_MS);
}

function finishThreat(incidentId: string): void {
  const incident = db.getIncident(incidentId);
  if (!incident || incident.status !== "open") return;

  const votes = db.getVotes(incidentId);
  if (votes.length === 0) {
    const resolved = db.resolveIncident(incidentId, {
      consensusSeverity: null,
      consensusLikelihood: null,
      consensusScore: null,
      outcome: "ignored",
    });
    hub.broadcast({ type: "threat:resolved", incident: resolved, threatIndex });
    narrate("RESOLVE", `Threat ID: ${shortId(incidentId)} resolved with no votes cast.`);
  } else {
    const resolution = resolveConsensus(votes);
    const resolved = db.resolveIncident(incidentId, {
      consensusSeverity: resolution.consensusSeverity,
      consensusLikelihood: resolution.consensusLikelihood,
      consensusScore: resolution.consensusScore,
      outcome: resolution.outcome,
    });
    hub.broadcast({ type: "threat:resolved", incident: resolved, threatIndex });
    narrate(
      "RESOLVE",
      `Threat ID: ${shortId(incidentId)} resolved. Outcome: ${resolution.outcome} (consensus score ${resolution.consensusScore}).`,
    );
  }

  threatIndex += 1;
  if (threatIndex < TOTAL_THREATS) {
    startThreat();
  } else {
    startAudit();
  }
}

function startAudit(): void {
  gamePhase = "audit";
  auditVotes = new Map();
  phaseDeadline = Date.now() + AUDIT_DURATION_MS;
  const candidates = connectedPlayers();

  hub.broadcast({ type: "audit:start", deadline: phaseDeadline, candidates });
  narrate("AUDIT STARTED", "30-second voting phase initiated.");

  gameTimer = setTimeout(() => finishAudit(), AUDIT_DURATION_MS);
}

function finishAudit(): void {
  const counts = tally();
  let ejectedId: string | null = null;
  let topCount = 0;
  let tied = false;
  for (const [id, count] of Object.entries(counts)) {
    if (count > topCount) {
      topCount = count;
      ejectedId = id;
      tied = false;
    } else if (count === topCount && topCount > 0) {
      tied = true;
    }
  }
  if (tied) ejectedId = null;

  const wasInsider = ejectedId !== null && ejectedId === insiderId;
  const winner: "ANALYSTS" | "INSIDER" = wasInsider ? "ANALYSTS" : "INSIDER";
  const insiderCodename = codenameOf(insiderId!);
  const ejectedCodename = ejectedId ? codenameOf(ejectedId) : null;

  lastResult = { ejectedId, ejectedCodename, wasInsider, winner, insiderCodename };
  gamePhase = "resolved";

  hub.broadcast({ type: "game:ejected", ejectedId, ejectedCodename, wasInsider, winner, insiderCodename });

  if (ejectedId) {
    narrate("EJECTED", `${ejectedCodename} was ejected. They ${wasInsider ? "WERE" : "WERE NOT"} the Insider Threat.`);
    hub.sendTo(ejectedId, { type: "game:revoked" });
  } else {
    narrate("EJECTED", `No one reached a majority — nobody was ejected. The Insider Threat was ${insiderCodename}.`);
  }
}

// Strict server-side authorization: a session can only submit one vote per
// threat (db.insertVote enforces the (incident, analyst) uniqueness), and
// only while that exact threat is the active one — never trusts anything the
// client claims about phase or incident id.
function castVote(analyst: Analyst, incidentId: string, severity: number, likelihood: number): boolean {
  if (gamePhase !== "threat" || incidentId !== currentIncidentId) {
    db.logAction(analyst.id, analyst.codename, "vote:denied", `incident=${incidentId} reason=not-active`);
    narrate("DENIED", `${analyst.codename} attempted to vote outside the active threat window.`);
    return false;
  }
  if (!Number.isInteger(severity) || severity < 1 || severity > 10 || !Number.isInteger(likelihood) || likelihood < 1 || likelihood > 10) {
    db.logAction(analyst.id, analyst.codename, "vote:denied", `incident=${incidentId} reason=invalid-range severity=${severity} likelihood=${likelihood}`);
    narrate("DENIED", `${analyst.codename} submitted an out-of-range vote (Sev: ${severity}, Lik: ${likelihood}).`);
    return false;
  }

  const inserted = db.insertVote(incidentId, analyst.id, severity, likelihood);
  if (!inserted) {
    db.logAction(analyst.id, analyst.codename, "vote:denied", `incident=${incidentId} reason=already-voted`);
    narrate("DENIED", `${analyst.codename} attempted to vote twice on same threat.`);
    return false;
  }

  db.logAction(analyst.id, analyst.codename, "vote", `incident=${incidentId} severity=${severity} likelihood=${likelihood}`);
  narrate("VOTE", `${analyst.codename} locked in Sev: ${severity}, Lik: ${likelihood}.`);
  hub.broadcast({
    type: "vote:cast",
    incidentId,
    analystId: analyst.id,
    codename: analyst.codename,
    severity,
    likelihood,
  });
  return true;
}

// Same authorization posture as castVote: one audit vote per session per
// round, only accepted during the audit phase, and only naming a currently
// connected player — all checked server-side regardless of what the UI
// would have let a well-behaved client submit.
function castAuditVote(analyst: Analyst, targetId: string): boolean {
  if (gamePhase !== "audit") {
    db.logAction(analyst.id, analyst.codename, "audit:vote:denied", "reason=not-audit-phase");
    narrate("DENIED", `${analyst.codename} attempted to cast an audit vote outside the audit phase.`);
    return false;
  }
  if (auditVotes.has(analyst.id)) {
    db.logAction(analyst.id, analyst.codename, "audit:vote:denied", "reason=already-voted");
    narrate("DENIED", `${analyst.codename} attempted to vote twice in the audit.`);
    return false;
  }
  if (!hub.connectedAnalystIds().includes(targetId)) {
    db.logAction(analyst.id, analyst.codename, "audit:vote:denied", `reason=invalid-target target=${targetId}`);
    narrate("DENIED", `${analyst.codename} attempted to vote for a codename that isn't connected.`);
    return false;
  }

  auditVotes.set(analyst.id, targetId);
  db.logAction(analyst.id, analyst.codename, "audit:vote", `target=${targetId}`);
  narrate("AUDIT VOTE", `${analyst.codename} voted to revoke ${codenameOf(targetId)}.`);
  hub.broadcast({
    type: "audit:tally",
    voterId: analyst.id,
    voterCodename: analyst.codename,
    targetId,
    targetCodename: codenameOf(targetId),
    tally: tally(),
  });
  return true;
}

function playAgain(analyst: Analyst): boolean {
  if (gamePhase !== "resolved") {
    db.logAction(analyst.id, analyst.codename, "game:play-again:denied", "reason=round-not-resolved");
    narrate("DENIED", `${analyst.codename} attempted to start a new round before this one resolved.`);
    return false;
  }
  if (gameTimer) clearTimeout(gameTimer);
  gamePhase = "lobby";
  insiderId = null;
  threatIndex = 0;
  currentIncidentId = null;
  auditVotes = new Map();
  lastResult = null;
  db.logAction(analyst.id, analyst.codename, "game:play-again");
  narrate("RESET", `${analyst.codename} reset the room for a new shift.`);
  hub.broadcast({ type: "game:reset" });
  broadcastLobby();
  return true;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function serveStatic(filePath: string, res: ServerResponse): boolean {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  const type = STATIC_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(filePath).pipe(res);
  return true;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    resolveIdentity(req, res);
    serveStatic(join("public", "index.html"), res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/readme/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderReadmePage());
    return;
  }

  if (req.method === "GET" && (url.pathname === "/style.css" || url.pathname === "/app.js" || url.pathname === "/intro.js")) {
    if (serveStatic(join("public", url.pathname), res)) return;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const analyst = resolveIdentity(req, res);
    sendJson(res, 200, { id: analyst.id, codename: analyst.codename });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/game/state") {
    const analyst = resolveIdentity(req, res);
    sendJson(res, 200, {
      me: { id: analyst.id, codename: analyst.codename },
      ...gameSnapshotFor(analyst.id),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/game/start") {
    const analyst = resolveIdentity(req, res);
    const ok = startGame(analyst);
    sendJson(res, ok ? 200 : 400, { ok });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/game/play-again") {
    const analyst = resolveIdentity(req, res);
    const ok = playAgain(analyst);
    sendJson(res, ok ? 200 : 400, { ok });
    return;
  }

  const voteMatch = /^\/api\/incidents\/([^/]+)\/vote$/.exec(url.pathname);
  if (req.method === "POST" && voteMatch) {
    const analyst = resolveIdentity(req, res);
    const body = (await readJsonBody(req)) as Partial<{ severity: number; likelihood: number }>;
    const ok = castVote(analyst, voteMatch[1]!, Number(body.severity), Number(body.likelihood));
    sendJson(res, ok ? 200 : 400, { ok });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/game/audit-vote") {
    const analyst = resolveIdentity(req, res);
    const body = (await readJsonBody(req)) as Partial<{ targetId: string }>;
    const ok = castAuditVote(analyst, String(body.targetId ?? ""));
    sendJson(res, ok ? 200 : 400, { ok });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  // The client always loads `/` first, which sets the cookie this depends on;
  // a WS upgrade with no valid cookie means something skipped that, so it's
  // rejected rather than minted fresh (an upgrade response can't set cookies).
  const cookie = readAnalystCookie(req);
  const analystId = cookie ? signer.verify(cookie) : undefined;
  const analyst = analystId ? db.getAnalyst(analystId) ?? db.createAnalyst(analystId, generateCodename()) : undefined;
  if (!analyst) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    hub.add(ws, analyst.id);
    ws.send(JSON.stringify({ type: "hello", me: { id: analyst.id, codename: analyst.codename }, ...gameSnapshotFor(analyst.id) }));
    narrate("JOIN", `User '${analyst.codename}' connected (Session: ${shortId(analyst.id)}).`);
    broadcastLobby();

    ws.on("close", () => {
      narrate("LEAVE", `User '${analyst.codename}' disconnected (Session: ${shortId(analyst.id)}).`);
      broadcastLobby();
    });

    ws.on("message", (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "game:start") {
        startGame(analyst);
      } else if (message.type === "vote") {
        castVote(analyst, message.incidentId, message.severity, message.likelihood);
      } else if (message.type === "audit:vote") {
        castAuditVote(analyst, message.targetId);
      } else if (message.type === "game:play-again") {
        playAgain(analyst);
      }
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  narrate("START", `Server listening on 0.0.0.0:${PORT}`);
});
