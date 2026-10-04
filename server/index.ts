import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { WebSocketServer } from "ws";
import { Db } from "./db.ts";
import { analystAgreements, resolveConsensus } from "./consensus.ts";
import { generateThreat, INCIDENT_CATEGORIES } from "./generator.ts";
import { analystCookieHeader, generateCodename, IdentitySigner, readAnalystCookie } from "./identity.ts";
import { renderReadmePage } from "./readme.ts";
import { Hub } from "./ws.ts";
import type { Analyst, ClientMessage, IncidentCategory } from "./types.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const RESOLVE_AFTER_MS = 3 * 60_000;
const RESOLVE_AT_VOTE_COUNT = 4;
const MAX_OPEN_INCIDENTS = 5;

const db = new Db(DATA_DIR);
const signer = new IdentitySigner(DATA_DIR);
const hub = new Hub();

function resolveIdentity(req: IncomingMessage, res: ServerResponse): Analyst {
  const cookie = readAnalystCookie(req);
  const verifiedId = cookie ? signer.verify(cookie) : undefined;

  if (verifiedId) {
    const existing = db.getAnalyst(verifiedId);
    if (existing) return existing;
    return db.createAnalyst(verifiedId, generateCodename());
  }

  const minted = signer.mint();
  res.setHeader("Set-Cookie", analystCookieHeader(minted.cookie));
  return db.createAnalyst(minted.id, generateCodename());
}

function tryResolveIncident(incidentId: string): void {
  const incident = db.getIncident(incidentId);
  if (!incident || incident.status !== "open") return;

  const votes = db.getVotes(incidentId);
  const age = Date.now() - incident.createdAt;
  const ready = votes.length >= RESOLVE_AT_VOTE_COUNT || age >= RESOLVE_AFTER_MS;
  if (!ready) return;

  if (votes.length === 0) {
    const resolved = db.resolveIncident(incidentId, {
      consensusSeverity: null,
      consensusLikelihood: null,
      consensusScore: null,
      outcome: "unresolved",
    });
    hub.broadcast({ type: "incident:resolved", incident: resolved });
    return;
  }

  const resolution = resolveConsensus(votes);
  const resolved = db.resolveIncident(incidentId, {
    consensusSeverity: resolution.consensusSeverity,
    consensusLikelihood: resolution.consensusLikelihood,
    consensusScore: resolution.consensusScore,
    outcome: resolution.outcome,
  });
  hub.broadcast({ type: "incident:resolved", incident: resolved });

  for (const outcome of analystAgreements(votes, resolution.consensusSeverity, resolution.consensusLikelihood)) {
    const entry = db.recordAnalystOutcome(outcome.analystId, outcome.agreement, outcome.isInsiderOutlier);
    hub.broadcast({ type: "analyst:stats", entry });
  }
}

function sweepStaleIncidents(): void {
  for (const incident of db.getOpenIncidents()) tryResolveIncident(incident.id);
}

function castVote(analyst: Analyst, incidentId: string, severity: number, likelihood: number): boolean {
  const incident = db.getIncident(incidentId);
  if (!incident || incident.status !== "open") return false;
  if (!Number.isInteger(severity) || severity < 1 || severity > 5) return false;
  if (!Number.isInteger(likelihood) || likelihood < 1 || likelihood > 5) return false;

  db.upsertVote(incidentId, analyst.id, severity, likelihood);
  hub.broadcast({
    type: "vote:cast",
    incidentId,
    analystId: analyst.id,
    codename: analyst.codename,
    severity,
    likelihood,
  });
  tryResolveIncident(incidentId);
  return true;
}

function createIncident(
  analyst: Analyst | null,
  title: string,
  description: string,
  category: IncidentCategory,
): boolean {
  if (!title.trim() || !description.trim()) return false;
  if (!INCIDENT_CATEGORIES.includes(category)) return false;
  if (db.openIncidentCount() >= MAX_OPEN_INCIDENTS) return false;

  const incident = db.createIncident({
    id: randomUUID(),
    title: title.trim().slice(0, 200),
    description: description.trim().slice(0, 1000),
    category,
    source: analyst ? "analyst" : "generator",
    createdBy: analyst ? analyst.id : null,
  });
  hub.broadcast({ type: "incident:new", incident: db.incidentView(incident) });
  return true;
}

function stateSnapshot(analyst: Analyst) {
  return {
    me: { id: analyst.id, codename: analyst.codename },
    openIncidents: db.getOpenIncidents().map((incident) => db.incidentView(incident)),
    recentResolved: db.getResolvedIncidents(20),
    leaderboard: db.getLeaderboard(),
  };
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

  if (req.method === "GET" && (url.pathname === "/style.css" || url.pathname === "/app.js")) {
    if (serveStatic(join("public", url.pathname), res)) return;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const analyst = resolveIdentity(req, res);
    sendJson(res, 200, { id: analyst.id, codename: analyst.codename });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const analyst = resolveIdentity(req, res);
    sendJson(res, 200, stateSnapshot(analyst));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/incidents") {
    const analyst = resolveIdentity(req, res);
    const body = (await readJsonBody(req)) as Partial<{ title: string; description: string; category: string }>;
    const ok = createIncident(
      analyst,
      String(body.title ?? ""),
      String(body.description ?? ""),
      String(body.category ?? "") as IncidentCategory,
    );
    sendJson(res, ok ? 201 : 400, { ok });
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
    ws.send(JSON.stringify({ type: "hello", ...stateSnapshot(analyst) }));

    ws.on("message", (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "vote") {
        castVote(analyst, message.incidentId, message.severity, message.likelihood);
      } else if (message.type === "incident:create") {
        createIncident(analyst, message.title, message.description, message.category);
      }
    });
  });
});

function scheduleNextThreat(): void {
  const delay = 45_000 + Math.random() * 45_000;
  setTimeout(() => {
    if (db.openIncidentCount() < MAX_OPEN_INCIDENTS) {
      const threat = generateThreat();
      createIncident(null, threat.title, threat.description, threat.category);
    }
    scheduleNextThreat();
  }, delay);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
  scheduleNextThreat();
  setInterval(sweepStaleIncidents, 10_000);
});
