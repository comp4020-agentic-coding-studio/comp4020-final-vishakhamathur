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
const ACTIVE_DURATION_MS = 15_000;
const MAX_QUEUED = 5;

const db = new Db(DATA_DIR);
const signer = new IdentitySigner(DATA_DIR);
const hub = new Hub();

// Live narration for the crit demo: the presenter reads these off `flyctl
// logs` while never touching the app, so every tag names an actor and every
// line is self-contained (no scrolling back for context). `logAction`
// writes the durable, queryable record to `/data`; `narrate` is the
// human-readable stream for reading along live. Keep both in sync at each
// call site rather than trying to derive one from the other.
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
    narrate("NEW", `User '${created.codename}' identified (SessionID: ${shortId(created.id)})`);
    return created;
  }

  const minted = signer.mint();
  res.setHeader("Set-Cookie", analystCookieHeader(minted.cookie));
  const created = db.createAnalyst(minted.id, generateCodename());
  narrate("NEW", `User '${created.codename}' identified (SessionID: ${shortId(created.id)})`);
  return created;
}

// Active incident's resolution timer, so a moderator's "resolve now" can
// cancel the pending timeout instead of racing it (both would otherwise
// try to resolve + advance the same incident).
let activeTimer: NodeJS.Timeout | null = null;

// "Won by" framing for the narration line: who the consensus sided with,
// in terms a non-technical listener following along from logs can parse.
const OUTCOME_LABEL: Record<string, string> = {
  true_positive: "Analysts (confirmed threat)",
  false_positive: "Analysts (false alarm)",
  unresolved: "Nobody — no consensus reached",
  ignored: "Nobody — no votes cast",
};

function finishIncident(incidentId: string): void {
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
    hub.broadcast({ type: "incident:resolved", incident: resolved });
    narrate(
      "RESOLVE",
      `Threat ID: ${shortId(incidentId)} resolved. Consensus: none. Won by: ${OUTCOME_LABEL.ignored}.`,
    );
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
  // "Consensus" in the narration is the severity/likelihood blend on the
  // same 1-10 scale analysts voted on (not `consensusScore`, which is the
  // 0-100 *agreement* percentage) — the number a listener following along
  // actually wants is "how bad did the room say this was."
  const consensusLevel = ((resolution.consensusSeverity + resolution.consensusLikelihood) / 2).toFixed(1);
  narrate(
    "RESOLVE",
    `Threat ID: ${shortId(incidentId)} resolved. Consensus: ${consensusLevel}. Won by: ${OUTCOME_LABEL[resolution.outcome]}.`,
  );

  for (const outcome of analystAgreements(votes, resolution.consensusSeverity, resolution.consensusLikelihood)) {
    const entry = db.recordAnalystOutcome(outcome.analystId, outcome.agreement, outcome.isInsiderOutlier);
    hub.broadcast({ type: "analyst:stats", entry });
    if (outcome.isInsiderOutlier) {
      narrate("FLAG", `User '${entry.codename}' flagged as possible insider (agreement: ${Math.round(outcome.agreement * 100)}%)`);
    }
  }
}

function resolveActive(incidentId: string): void {
  finishIncident(incidentId);
  startNextIncident();
}

// Focus Mode: exactly one threat is ever active. The next one comes from the
// analyst report queue first (FIFO), falling back to the ambient generator,
// and runs for a strict ACTIVE_DURATION_MS before resolveActive fires again.
function startNextIncident(): void {
  const queued = db.getQueuedIncidents()[0];
  const incident = queued
    ? db.activateIncident(queued.id)
    : (() => {
        const threat = generateThreat();
        return db.createIncident({
          id: randomUUID(),
          title: threat.title,
          description: threat.description,
          category: threat.category,
          source: "generator",
          createdBy: null,
          status: "open",
        });
      })();

  if (queued) hub.broadcast({ type: "queue:update", queueLength: db.queuedIncidentCount() });
  hub.broadcast({ type: "incident:new", incident: db.incidentView(incident) });
  narrate(
    "THREAT",
    `New active threat — ID: ${shortId(incident.id)} "${incident.title}" (${incident.source === "analyst" ? "analyst-reported" : "auto-generated"})`,
  );
  activeTimer = setTimeout(() => resolveActive(incident.id), ACTIVE_DURATION_MS);
}

// Moderator-only: skip the remaining countdown and resolve the active
// incident immediately, then advance Focus Mode as usual. Returns false if
// there's nothing active to resolve (nothing for the caller to do, not a
// permission failure — the permission check happens before this is called).
function moderatorResolveNow(): boolean {
  const active = db.getOpenIncidents()[0];
  if (!active) return false;
  if (activeTimer) clearTimeout(activeTimer);
  resolveActive(active.id);
  return true;
}

function castVote(analyst: Analyst, incidentId: string, severity: number, likelihood: number): boolean {
  const incident = db.getIncident(incidentId);
  if (!incident || incident.status !== "open") {
    db.logAction(analyst.id, analyst.codename, "vote:denied", `incident=${incidentId} reason=not-open`);
    narrate("DENIED", `User '${analyst.codename}' attempted to vote on Threat ID: ${shortId(incidentId)}, but it is not currently active.`);
    return false;
  }
  if (!Number.isInteger(severity) || severity < 1 || severity > 10 || !Number.isInteger(likelihood) || likelihood < 1 || likelihood > 10) {
    db.logAction(analyst.id, analyst.codename, "vote:denied", `incident=${incidentId} reason=invalid-range severity=${severity} likelihood=${likelihood}`);
    narrate("DENIED", `User '${analyst.codename}' submitted an out-of-range vote (Sev: ${severity}, Lik: ${likelihood}) on Threat ID: ${shortId(incidentId)}.`);
    return false;
  }

  // Strict one-vote-per-analyst-per-threat: a second attempt on the same
  // incident is rejected, not treated as an update, regardless of whether
  // it arrived over REST or the WS path.
  const inserted = db.insertVote(incidentId, analyst.id, severity, likelihood);
  if (!inserted) {
    db.logAction(analyst.id, analyst.codename, "vote:denied", `incident=${incidentId} reason=already-voted`);
    narrate("DENIED", `User '${analyst.codename}' attempted to vote twice on Threat ID: ${shortId(incidentId)}.`);
    return false;
  }

  db.logAction(analyst.id, analyst.codename, "vote", `incident=${incidentId} severity=${severity} likelihood=${likelihood}`);
  narrate("VOTE", `User '${analyst.codename}' voted Sev: ${severity}, Lik: ${likelihood} on Threat ID: ${shortId(incidentId)}`);
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

function reportIncident(analyst: Analyst, title: string, description: string, category: IncidentCategory): boolean {
  if (!title.trim() || !description.trim()) {
    db.logAction(analyst.id, analyst.codename, "report:denied", "reason=missing-fields");
    narrate("DENIED", `User '${analyst.codename}' submitted an incomplete incident report.`);
    return false;
  }
  if (!INCIDENT_CATEGORIES.includes(category)) {
    db.logAction(analyst.id, analyst.codename, "report:denied", `reason=invalid-category category=${category}`);
    narrate("DENIED", `User '${analyst.codename}' submitted a report with an invalid category.`);
    return false;
  }
  if (db.queuedIncidentCount() >= MAX_QUEUED) {
    db.logAction(analyst.id, analyst.codename, "report:denied", "reason=queue-full");
    narrate("DENIED", `User '${analyst.codename}' attempted to report an incident, but the queue is full.`);
    return false;
  }

  const trimmedTitle = title.trim().slice(0, 200);
  db.createIncident({
    id: randomUUID(),
    title: trimmedTitle,
    description: description.trim().slice(0, 1000),
    category,
    source: "analyst",
    createdBy: analyst.id,
    status: "queued",
  });
  db.logAction(analyst.id, analyst.codename, "report", `title=${JSON.stringify(trimmedTitle)}`);
  narrate("REPORT", `User '${analyst.codename}' reported new incident: "${trimmedTitle}"`);
  hub.broadcast({ type: "queue:update", queueLength: db.queuedIncidentCount() });
  return true;
}

function stateSnapshot(analyst: Analyst) {
  const open = db.getOpenIncidents()[0];
  return {
    me: { id: analyst.id, codename: analyst.codename, isModerator: db.isModerator(analyst.id) },
    active: open ? db.incidentView(open) : null,
    queueLength: db.queuedIncidentCount(),
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
    const ok = reportIncident(
      analyst,
      String(body.title ?? ""),
      String(body.description ?? ""),
      String(body.category ?? "") as IncidentCategory,
    );
    sendJson(res, ok ? 201 : 400, { ok });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/moderator/resolve-now") {
    const analyst = resolveIdentity(req, res);
    if (!db.isModerator(analyst.id)) {
      db.logAction(analyst.id, analyst.codename, "resolve-now:denied");
      narrate("DENIED", `User '${analyst.codename}' attempted a moderator-only action (resolve-now) without permission.`);
      sendJson(res, 403, { ok: false, error: "moderator only" });
      return;
    }
    const ok = moderatorResolveNow();
    db.logAction(analyst.id, analyst.codename, "resolve-now");
    narrate("MODERATE", `Moderator '${analyst.codename}' forced resolution of the active threat.`);
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
    narrate("JOIN", `User '${analyst.codename}' connected (SessionID: ${shortId(analyst.id)})`);

    ws.on("close", () => {
      narrate("LEAVE", `User '${analyst.codename}' disconnected (SessionID: ${shortId(analyst.id)})`);
    });

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
        reportIncident(analyst, message.title, message.description, message.category);
      } else if (message.type === "moderator:resolve-now") {
        if (!db.isModerator(analyst.id)) {
          db.logAction(analyst.id, analyst.codename, "resolve-now:denied");
          narrate("DENIED", `User '${analyst.codename}' attempted a moderator-only action (resolve-now) without permission.`);
          return;
        }
        moderatorResolveNow();
        db.logAction(analyst.id, analyst.codename, "resolve-now");
        narrate("MODERATE", `Moderator '${analyst.codename}' forced resolution of the active threat.`);
      }
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  narrate("START", `Server listening on 0.0.0.0:${PORT}`);
  // Leftover 'open' rows mean the process restarted (or ran under the old,
  // pre-Focus-Mode code that allowed several at once); close all of them out
  // against whatever votes they already have before starting the loop fresh.
  for (const incident of db.getOpenIncidents()) finishIncident(incident.id);
  startNextIncident();
});
